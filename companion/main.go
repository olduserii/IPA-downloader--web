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

// memoryCookieJar wraps net/http/cookiejar to satisfy ipatool's pkg/http.CookieJar interface.
type memoryCookieJar struct {
	*cookiejar.Jar
}

func (m *memoryCookieJar) Save() error {
	return nil
}

// memoryKeychain keeps credentials strictly in RAM and never writes passwords to disk.
// Machine-level anisette provisioning state ("anisette-v4") is optionally shared in RAM
// across logins so subsequent requests skip slow re-provisioning.
type memoryKeychain struct {
	mu           sync.RWMutex
	data         map[string][]byte
	sharedDevice *sharedAnisetteStore
}

type sharedAnisetteStore struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func newSharedAnisetteStore() *sharedAnisetteStore {
	return &sharedAnisetteStore{data: make(map[string][]byte)}
}

func (s *sharedAnisetteStore) Get(key string) ([]byte, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, ok := s.data[key]
	if !ok {
		return nil, false
	}
	cp := make([]byte, len(val))
	copy(cp, val)
	return cp, true
}

func (s *sharedAnisetteStore) Set(key string, val []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(val))
	copy(cp, val)
	s.data[key] = cp
}

var globalAnisette = newSharedAnisetteStore()

func newMemoryKeychain() *memoryKeychain {
	return &memoryKeychain{
		data:         make(map[string][]byte),
		sharedDevice: globalAnisette,
	}
}

func (m *memoryKeychain) Get(key string) ([]byte, error) {
	if key == "anisette-v4" && m.sharedDevice != nil {
		if val, ok := m.sharedDevice.Get(key); ok {
			return val, nil
		}
	}
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
	if key == "anisette-v4" && m.sharedDevice != nil {
		m.sharedDevice.Set(key, val)
		return nil
	}
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

type pendingAuthEntry struct {
	store     appstore.AppStore
	guid      string
	account   *appstore.Account
	expiresAt time.Time
}

type pendingAuthCache struct {
	mu      sync.Mutex
	entries map[string]pendingAuthEntry
}

func newPendingAuthCache() *pendingAuthCache {
	return &pendingAuthCache{entries: make(map[string]pendingAuthEntry)}
}

func (c *pendingAuthCache) Get(email string) (appstore.AppStore, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, v := range c.entries {
		if now.After(v.expiresAt) {
			delete(c.entries, k)
		}
	}
	entry, ok := c.entries[strings.ToLower(strings.TrimSpace(email))]
	if !ok {
		return nil, "", false
	}
	return entry.store, entry.guid, true
}

func (c *pendingAuthCache) Put(email string, store appstore.AppStore, guid string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[strings.ToLower(strings.TrimSpace(email))] = pendingAuthEntry{
		store:     store,
		guid:      guid,
		expiresAt: time.Now().Add(5 * time.Minute),
	}
}

func (c *pendingAuthCache) Delete(email string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, strings.ToLower(strings.TrimSpace(email)))
}

type activeSessionCache struct {
	mu      sync.Mutex
	entries map[string]pendingAuthEntry
}

func newActiveSessionCache() *activeSessionCache {
	return &activeSessionCache{entries: make(map[string]pendingAuthEntry)}
}

func (c *activeSessionCache) Get(dsid string) (appstore.AppStore, *appstore.Account, bool) {
	key := strings.TrimSpace(dsid)
	if key == "" {
		return nil, nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for k, v := range c.entries {
		if now.After(v.expiresAt) {
			delete(c.entries, k)
		}
	}
	entry, ok := c.entries[key]
	if !ok {
		return nil, nil, false
	}
	return entry.store, entry.account, true
}

func (c *activeSessionCache) Put(dsid string, store appstore.AppStore, guid string, acc *appstore.Account) {
	key := strings.TrimSpace(dsid)
	if key == "" || store == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var accCopy *appstore.Account
	if acc != nil {
		cp := *acc
		cp.Password = ""
		accCopy = &cp
	}
	c.entries[key] = pendingAuthEntry{
		store:     store,
		guid:      guid,
		account:   accCopy,
		expiresAt: time.Now().Add(24 * time.Hour),
	}
}

func newEphemeralStore() (appstore.AppStore, string, error) {
	osSvc := operatingsystem.New()
	mach := machine.New(machine.Args{OS: osSvc})
	rawJar, err := cookiejar.New(nil)
	if err != nil {
		return nil, "", err
	}
	jar := &memoryCookieJar{Jar: rawJar}
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
	pending2FA := newPendingAuthCache()
	activeSessions := newActiveSessionCache()

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

		email := strings.TrimSpace(req.Email)
		code := strings.TrimSpace(req.Code)

		var (
			store appstore.AppStore
			guid  string
			err   error
		)
		if code != "" {
			if cachedStore, cachedGuid, ok := pending2FA.Get(email); ok {
				store = cachedStore
				guid = cachedGuid
			}
		}
		if store == nil {
			store, guid, err = newEphemeralStore()
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"status": "error", "message": err.Error()})
				return
			}
		}

		out, err := store.Login(appstore.LoginInput{
			Email:    email,
			Password: req.Password,
			AuthCode: code,
		})
		if err != nil {
			if errors.Is(err, appstore.ErrAuthCodeRequired) {
				pending2FA.Put(email, store, guid)
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

		pending2FA.Delete(email)

		// Never echo the raw Apple ID password back over HTTP
		acc := out.Account
		acc.Password = ""

		// Cache authenticated cookieJar/store and exact Apple-returned Account in RAM by DSID
		// so inspect & purchase reuse Apple's session cookies, real Pod, and real StoreFront.
		if acc.DirectoryServicesID != "" {
			activeSessions.Put(acc.DirectoryServicesID, store, guid, &acc)
		}

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
		store, cachedAcc, ok := activeSessions.Get(req.Account.DirectoryServicesID)
		if !ok {
			var guid string
			store, guid, err = newEphemeralStore()
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			activeSessions.Put(req.Account.DirectoryServicesID, store, guid, nil)
		}
		accountToUse := req.Account
		if cachedAcc != nil && cachedAcc.PasswordToken == req.Account.PasswordToken {
			// Preserve exact Pod and StoreFront returned by Apple on login
			accountToUse.Pod = cachedAcc.Pod
			if cachedAcc.StoreFront != "" {
				accountToUse.StoreFront = cachedAcc.StoreFront
			}
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
		out, err := insp.InspectDownload(ctx, accountToUse, appID, strings.TrimSpace(req.ExternalVersionID))
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
		store, cachedAcc, ok := activeSessions.Get(req.Account.DirectoryServicesID)
		if !ok {
			var guid string
			store, guid, err = newEphemeralStore()
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			activeSessions.Put(req.Account.DirectoryServicesID, store, guid, nil)
		}
		accountToUse := req.Account
		if cachedAcc != nil && cachedAcc.PasswordToken == req.Account.PasswordToken {
			accountToUse.Pod = cachedAcc.Pod
			if cachedAcc.StoreFront != "" {
				accountToUse.StoreFront = cachedAcc.StoreFront
			}
		}
		err = store.Purchase(appstore.PurchaseInput{
			Account:  accountToUse,
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
