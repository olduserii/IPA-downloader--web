package main

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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

const anisetteKeyName = "anisette-v4"

// memoryCookieJar wraps net/http/cookiejar to satisfy ipatool's pkg/http.CookieJar interface.
type memoryCookieJar struct {
	*cookiejar.Jar
}

func (m *memoryCookieJar) Save() error {
	return nil
}

// fixedMachine overrides MacAddress when restoring a session with a saved GUID so
// StoreAMDHeaders & kbsync use the exact same 6-byte hardwareID across container restarts.
type fixedMachine struct {
	machine.Machine
	mac string
}

func (f *fixedMachine) MacAddress() (string, error) {
	if f.mac != "" {
		return f.mac, nil
	}
	return f.Machine.MacAddress()
}

func formatGuidAsMac(guid string) string {
	clean := strings.ToUpper(strings.TrimSpace(guid))
	if len(clean) != 12 {
		return ""
	}
	for _, c := range clean {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			return ""
		}
	}
	return fmt.Sprintf("%s:%s:%s:%s:%s:%s",
		clean[0:2], clean[2:4], clean[4:6], clean[6:8], clean[8:10], clean[10:12])
}

// memoryKeychain keeps credentials strictly in RAM and never writes passwords to disk.
// Each store can hold its own provisioned anisette-v4 state (restored from token across restarts),
// while also falling back to shared RAM state for fast same-container reuse.
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

func newMemoryKeychain(initialAnisette []byte) *memoryKeychain {
	kc := &memoryKeychain{
		data:         make(map[string][]byte),
		sharedDevice: globalAnisette,
	}
	if len(initialAnisette) > 0 {
		cp := make([]byte, len(initialAnisette))
		copy(cp, initialAnisette)
		kc.data[anisetteKeyName] = cp
	}
	return kc
}

func (m *memoryKeychain) Get(key string) ([]byte, error) {
	m.mu.RLock()
	val, ok := m.data[key]
	m.mu.RUnlock()
	if ok {
		cp := make([]byte, len(val))
		copy(cp, val)
		return cp, nil
	}
	if key == anisetteKeyName && m.sharedDevice != nil {
		if sharedVal, sharedOk := m.sharedDevice.Get(key); sharedOk {
			return sharedVal, nil
		}
	}
	return nil, os.ErrNotExist
}

func (m *memoryKeychain) Set(key string, val []byte) error {
	cp := make([]byte, len(val))
	copy(cp, val)
	m.mu.Lock()
	m.data[key] = cp
	m.mu.Unlock()
	if key == anisetteKeyName && m.sharedDevice != nil {
		m.sharedDevice.Set(key, cp)
	}
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
	keychain  *memoryKeychain
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

func (c *pendingAuthCache) Get(email string) (appstore.AppStore, *memoryKeychain, string, bool) {
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
		return nil, nil, "", false
	}
	return entry.store, entry.keychain, entry.guid, true
}

func (c *pendingAuthCache) Put(email string, store appstore.AppStore, kc *memoryKeychain, guid string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[strings.ToLower(strings.TrimSpace(email))] = pendingAuthEntry{
		store:     store,
		keychain:  kc,
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

func (c *activeSessionCache) Get(dsid string) (appstore.AppStore, *memoryKeychain, *appstore.Account, bool) {
	key := strings.TrimSpace(dsid)
	if key == "" {
		return nil, nil, nil, false
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
		return nil, nil, nil, false
	}
	return entry.store, entry.keychain, entry.account, true
}

func (c *activeSessionCache) Put(dsid string, store appstore.AppStore, kc *memoryKeychain, guid string, acc *appstore.Account) {
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
		keychain:  kc,
		guid:      guid,
		account:   accCopy,
		expiresAt: time.Now().Add(24 * time.Hour),
	}
}

func newEphemeralStore(preferredGuid string, initialAnisette []byte) (appstore.AppStore, *memoryKeychain, string, error) {
	osSvc := operatingsystem.New()
	var mach machine.Machine = machine.New(machine.Args{OS: osSvc})
	if formattedMac := formatGuidAsMac(preferredGuid); formattedMac != "" {
		mach = &fixedMachine{Machine: mach, mac: formattedMac}
	}
	rawJar, err := cookiejar.New(nil)
	if err != nil {
		return nil, nil, "", err
	}
	jar := &memoryCookieJar{Jar: rawJar}
	kc := newMemoryKeychain(initialAnisette)
	store := appstore.NewAppStore(appstore.Args{
		CookieJar:       jar,
		OperatingSystem: osSvc,
		Keychain:        kc,
		Machine:         mach,
	})
	macAddr, _ := mach.MacAddress()
	guid := strings.ReplaceAll(strings.ToUpper(macAddr), ":", "")
	return store, kc, guid, nil
}

func decodeAnisetteState(encoded string) []byte {
	trimmed := strings.TrimSpace(encoded)
	if trimmed == "" || len(trimmed) > 32768 {
		return nil
	}
	raw, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(raw) == 0 {
		return nil
	}
	return raw
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
	GUID              string           `json:"guid,omitempty"`
	AnisetteState     string           `json:"anisetteState,omitempty"`
}

type purchaseReq struct {
	Account       appstore.Account `json:"account"`
	AppID         string           `json:"appID"`
	GUID          string           `json:"guid,omitempty"`
	AnisetteState string           `json:"anisetteState,omitempty"`
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
			kc    *memoryKeychain
			guid  string
			err   error
		)
		if code != "" {
			if cachedStore, cachedKc, cachedGuid, ok := pending2FA.Get(email); ok {
				store = cachedStore
				kc = cachedKc
				guid = cachedGuid
			}
		}
		if store == nil {
			store, kc, guid, err = newEphemeralStore("", nil)
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
				pending2FA.Put(email, store, kc, guid)
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

		// Export provisioned Store AMD / Anisette state so the client's encrypted token
		// works seamlessly even after Railway restarts or container migrations.
		anisetteB64 := ""
		if kc != nil {
			if rawState, getErr := kc.Get(anisetteKeyName); getErr == nil && len(rawState) > 0 {
				anisetteB64 = base64.StdEncoding.EncodeToString(rawState)
			}
		}

		if acc.DirectoryServicesID != "" {
			activeSessions.Put(acc.DirectoryServicesID, store, kc, guid, &acc)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "authenticated",
			"account":       acc,
			"guid":          guid,
			"anisetteState": anisetteB64,
		})
	})

	mux.HandleFunc("POST /v1/store/inspect", func(w http.ResponseWriter, r *http.Request) {
		if !authorize(r, bridgeSecret) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Unauthorized bridge secret"})
			return
		}
		var req inspectReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid JSON body"})
			return
		}
		appID, err := strconv.ParseInt(strings.TrimSpace(req.AppID), 10, 64)
		if err != nil || appID <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid appID"})
			return
		}

		providedAnisette := decodeAnisetteState(req.AnisetteState)
		store, kc, cachedAcc, ok := activeSessions.Get(req.Account.DirectoryServicesID)
		if !ok {
			var guid string
			store, kc, guid, err = newEphemeralStore(req.GUID, providedAnisette)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
			activeSessions.Put(req.Account.DirectoryServicesID, store, kc, guid, nil)
		} else if len(providedAnisette) > 0 && kc != nil {
			if _, getErr := kc.Get(anisetteKeyName); getErr != nil {
				_ = kc.Set(anisetteKeyName, providedAnisette)
			}
		}

		accountToUse := req.Account
		if cachedAcc != nil && cachedAcc.PasswordToken == req.Account.PasswordToken {
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
			msg := err.Error()
			if errors.Is(err, appstore.ErrPasswordTokenExpired) {
				code = "sessionExpired"
				status = http.StatusUnauthorized
			} else if strings.Contains(msg, "store AMD state is not provisioned") {
				code = "sessionExpired"
				status = http.StatusUnauthorized
				msg = "Сервер перезапустился, а в старом токене нет ключа устройства AMD. Выполните один новый вход по Apple ID и паролю — новый токен сохранит ключ устройства и больше не сбросится."
			} else if errors.Is(err, appstore.ErrLicenseRequired) {
				code = "licenseRequired"
				status = http.StatusForbidden
			}
			writeJSON(w, status, map[string]any{"code": code, "error": msg})
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
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "Invalid JSON body"})
			return
		}
		appID, err := strconv.ParseInt(strings.TrimSpace(req.AppID), 10, 64)
		if err != nil || appID <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "Invalid appID"})
			return
		}

		providedAnisette := decodeAnisetteState(req.AnisetteState)
		store, kc, cachedAcc, ok := activeSessions.Get(req.Account.DirectoryServicesID)
		if !ok {
			var guid string
			store, kc, guid, err = newEphemeralStore(req.GUID, providedAnisette)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			activeSessions.Put(req.Account.DirectoryServicesID, store, kc, guid, nil)
		} else if len(providedAnisette) > 0 && kc != nil {
			if _, getErr := kc.Get(anisetteKeyName); getErr != nil {
				_ = kc.Set(anisetteKeyName, providedAnisette)
			}
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
			msg := err.Error()
			if errors.Is(err, appstore.ErrPasswordTokenExpired) {
				code = "sessionExpired"
				status = http.StatusUnauthorized
			} else if strings.Contains(msg, "store AMD state is not provisioned") {
				code = "sessionExpired"
				status = http.StatusUnauthorized
				msg = "Сервер перезапустился, а в старом токене нет ключа устройства AMD. Выполните один новый вход по Apple ID и паролю — новый токен сохранит ключ устройства и больше не сбросится."
			}
			writeJSON(w, status, map[string]any{"ok": false, "code": code, "error": msg})
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
