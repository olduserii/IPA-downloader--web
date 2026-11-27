package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/cookiejar"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/majd/ipatool/v2/pkg/appstore"
	"github.com/majd/ipatool/v2/pkg/util/machine"
	"github.com/majd/ipatool/v2/pkg/util/operatingsystem"
)

// memoryKeychain keeps credentials strictly in RAM for the duration of a single request.
type memoryKeychain struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func newMemoryKeychain() *memoryKeychain {
	return &memoryKeychain{data: make(map[string][]byte)}
}

func (m *memoryKeychain) Get(key string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	val, ok := m.data[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	cp := make([]byte, len(val))
	copy(cp, val)
	return cp, nil
}

func (m *memoryKeychain) Set(key string, val []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, len(val))
	copy(cp, val)
	m.data[key] = cp
	return nil
}

func (m *memoryKeychain) Remove(key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
	return nil
}

func newEphemeralStore() (appstore.AppStore, string, error) {
	osSvc := operatingsystem.New()
	mach := machine.New(machine.Args{OS: osSvc})
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, "", err
	}
	store := appstore.NewAppStore(appstore.Args{
		CookieJar:       jar,
		OperatingSystem: osSvc,
		Keychain:        newMemoryKeychain(),
		Machine:         mach,
	})
	macAddr, _ := mach.MacAddress()
	guid := strings.ReplaceAll(strings.ToUpper(macAddr), ":", "")
	return store, guid, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func authorize(r *http.Request, expectedSecret string) bool {
	if expectedSecret == "" {
		return true
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	provided := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if len(provided) != len(expectedSecret) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expectedSecret)) == 1
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Code     string `json:"code"`
}

type inspectReq struct {
	Account           appstore.Account `json:"account"`
	AppID             string           `json:"appID"`
	ExternalVersionID string           `json:"externalVersionID"`
}

type purchaseReq struct {
	Account appstore.Account `json:"account"`
	AppID   string           `json:"appID"`
}

func main() {
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8080"
	}
	bridgeSecret := strings.TrimSpace(os.Getenv("BRIDGE_SECRET"))

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":              true,
			"engine":          "ipatool-sap-bridge",
			"secretProtected": bridgeSecret != "",
		})
	})

	mux.HandleFunc("POST /v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if !authorize(r, bridgeSecret) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"status": "error", "message": "Unauthorized bridge secret"})
			return
		}
		var req loginReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"status": "error", "message": "Invalid JSON body"})
			return
		}
		store, guid, err := newEphemeralStore()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": err.Error()})
			return
		}
		out, err := store.Login(appstore.LoginInput{
			Email:    strings.TrimSpace(req.Email),
			Password: req.Password,
			AuthCode: strings.TrimSpace(req.Code),
		})
		if err != nil {
			if errors.Is(err, appstore.ErrAuthCodeRequired) {
				writeJSON(w, http.StatusOK, map[string]any{
					"status":  "requires2fa",
					"guid":    guid,
					"message": "Apple запросил 6-значный код двухфакторной аутентификации (2FA) с вашего устройства.",
				})
				return
			}
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"status":  "error",
				"message": err.Error(),
			})
			return
		}
		// Never echo the raw Apple ID password back over HTTP
		acc := out.Account
		acc.Password = ""
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "authenticated",
			"account": acc,
			"guid":    guid,
		})
	})

	mux.HandleFunc("POST /v1/store/inspect", func(w http.ResponseWriter, r *http.Request) {
		if !authorize(r, bridgeSecret) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Unauthorized bridge secret"})
			return
		}
		var req inspectReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON body"})
			return
		}
		appID, err := strconv.ParseInt(strings.TrimSpace(req.AppID), 10, 64)
		if err != nil || appID <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid appID"})
			return
		}
		store, _, err := newEphemeralStore()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		type inspector interface {
			InspectDownload(context.Context, appstore.Account, int64, string) (appstore.InspectDownloadOutput, error)
		}
		insp, ok := store.(inspector)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "InspectDownload not compiled in"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
		defer cancel()
		out, err := insp.InspectDownload(ctx, req.Account, appID, strings.TrimSpace(req.ExternalVersionID))
		if err != nil {
			code := "unavailable"
			status := http.StatusBadRequest
			if errors.Is(err, appstore.ErrPasswordTokenExpired) {
				code = "sessionExpired"
				status = http.StatusUnauthorized
			} else if errors.Is(err, appstore.ErrLicenseRequired) {
				code = "licenseRequired"
				status = http.StatusForbidden
			}
			writeJSON(w, status, map[string]any{"code": code, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, out)
	})

	mux.HandleFunc("POST /v1/store/purchase", func(w http.ResponseWriter, r *http.Request) {
		if !authorize(r, bridgeSecret) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "Unauthorized bridge secret"})
			return
		}
		var req purchaseReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "Invalid JSON body"})
			return
		}
		appID, err := strconv.ParseInt(strings.TrimSpace(req.AppID), 10, 64)
		if err != nil || appID <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "Invalid appID"})
			return
		}
		store, _, err := newEphemeralStore()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		err = store.Purchase(appstore.PurchaseInput{
			Account:  req.Account,
			App:      appstore.App{ID: appID},
			Platform: appstore.PlatformIPhone,
		})
		if err != nil && !errors.Is(err, appstore.ErrLicenseAlreadyExists) {
			code := "unavailable"
			status := http.StatusBadRequest
			if errors.Is(err, appstore.ErrPasswordTokenExpired) {
				code = "sessionExpired"
				status = http.StatusUnauthorized
			}
			writeJSON(w, status, map[string]any{"ok": false, "code": code, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"message": "Бесплатная лицензия добавлена на ваш Apple ID.",
		})
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("IPA Vault FairPlay SAP Bridge listening on :%s", port)
	log.Fatal(srv.ListenAndServe())
}
