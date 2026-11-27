import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Moon,
  RefreshCw,
  Server,
  ShieldCheck,
  Sun,
  Upload,
} from 'lucide-react';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import {
  apiFetchAnisetteServers,
  apiGenerateSessionToken,
  apiGetBridgeStatus,
  apiLoginAppleId,
  apiLoginWithSessionToken,
  apiTestAnisette,
  apiTestBridge,
  apiUpdateSessionPolicy,
  downloadTextFile,
  getSavedBridgeConfig,
  saveBridgeConfig,
} from '../lib/api.ts';
import type {
  AnisetteServer,
  AnisetteTestResult,
  AppleSessionSummary,
  BridgeTestResult,
  SessionPersistMode,
} from '../shared/types.ts';

interface AccountViewProps {
  authToken: string | null;
  session: AppleSessionSummary | null;
  onAuthenticated: (token: string, session: AppleSessionSummary) => void;
  onSignOut: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

type LoginTab = 'credentials' | 'session';

function formatRemainingTime(expiresAt: number): string {
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return 'Истекла';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days >= 1) return `${days} дн. ${hours} ч`;
  if (hours >= 1) return `${hours} ч ${mins} мин`;
  return `${Math.max(1, mins)} мин`;
}

export function AccountView({
  authToken,
  session,
  onAuthenticated,
  onSignOut,
  darkMode,
  onToggleDarkMode,
}: AccountViewProps) {
  const [loginTab, setLoginTab] = useState<LoginTab>('credentials');

  // Apple ID credentials login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [requires2FA, setRequires2FA] = useState(false);
  const [pendingGuid, setPendingGuid] = useState<string | undefined>(undefined);
  const [pendingAuthEndpoint, setPendingAuthEndpoint] = useState<string | undefined>(undefined);
  const [loginPersistMode, setLoginPersistMode] = useState<SessionPersistMode>('24h');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNeedsSapBridge, setAuthNeedsSapBridge] = useState(false);
  const [authInfo, setAuthInfo] = useState('');

  // Login via generated session token ("Вход по сессии")
  const [sessionTokenInput, setSessionTokenInput] = useState('');
  const [sessionPinInput, setSessionPinInput] = useState('');
  const [sessionNeedsPin, setSessionNeedsPin] = useState(false);
  const sessionFileRef = useRef<HTMLInputElement>(null);

  // Active session policy & generator
  const [isUpdatingPolicy, setIsUpdatingPolicy] = useState(false);
  const [confirmResetKeep, setConfirmResetKeep] = useState(false);
  const [genDurationMode, setGenDurationMode] = useState<'24h' | 'keep'>('keep');
  const [genPin, setGenPin] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSession, setGeneratedSession] = useState<{
    token: string;
    expiresAt: number;
    pinProtected: boolean;
  } | null>(null);
  const [copiedGen, setCopiedGen] = useState(false);
  const [policyMessage, setPolicyMessage] = useState('');

  // FairPlay SAP Bridge state
  const [envBridgeConfigured, setEnvBridgeConfigured] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState(() => getSavedBridgeConfig().bridgeUrl);
  const [bridgeSecret, setBridgeSecret] = useState(() => getSavedBridgeConfig().bridgeSecret);
  const [isTestingBridge, setIsTestingBridge] = useState(false);
  const [bridgeResult, setBridgeResult] = useState<BridgeTestResult | null>(null);

  // SideStore Anisette state
  const [useAnisette, setUseAnisette] = useState(true);
  const [servers, setServers] = useState<AnisetteServer[]>([]);
  const [selectedServer, setSelectedServer] = useState('');
  const [customAnisetteUrl, setCustomAnisetteUrl] = useState('');
  const [isTestingAnisette, setIsTestingAnisette] = useState(false);
  const [anisetteResult, setAnisetteResult] = useState<AnisetteTestResult | null>(null);

  useEffect(() => {
    apiGetBridgeStatus()
      .then((st) => setEnvBridgeConfigured(Boolean(st.configured)))
      .catch(() => {
        // ignore
      });

    apiFetchAnisetteServers()
      .then((list) => {
        setServers(list);
        if (list.length > 0 && !selectedServer) {
          setSelectedServer(list[0].address);
        }
      })
      .catch(() => {
        // Built-in failover works automatically
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeAnisetteUrl = customAnisetteUrl.trim().startsWith('https://')
    ? customAnisetteUrl.trim()
    : selectedServer;

  const handleTestAnisette = async () => {
    setIsTestingAnisette(true);
    setAnisetteResult(null);
    try {
      const res = await apiTestAnisette(activeAnisetteUrl || undefined);
      setAnisetteResult(res);
    } catch (err) {
      setAnisetteResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Ошибка подключения к Anisette',
      });
    } finally {
      setIsTestingAnisette(false);
    }
  };

  const handleTestBridge = async () => {
    saveBridgeConfig(bridgeUrl, bridgeSecret);
    setIsTestingBridge(true);
    setBridgeResult(null);
    try {
      const res = await apiTestBridge(bridgeUrl || undefined, bridgeSecret || undefined);
      setBridgeResult(res);
    } catch (err) {
      setBridgeResult({
        ok: false,
        error: err instanceof Error ? err.message : 'Ошибка подключения к FairPlay SAP Bridge',
      });
    } finally {
      setIsTestingBridge(false);
    }
  };

  const handleCredentialsLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthNeedsSapBridge(false);
    setAuthInfo('');
    setIsLoggingIn(true);
    saveBridgeConfig(bridgeUrl, bridgeSecret);

    try {
      const res = await apiLoginAppleId({
        email,
        password,
        code: requires2FA ? twoFactorCode : undefined,
        useAnisette,
        anisetteUrl: activeAnisetteUrl || undefined,
        guid: pendingGuid,
        authEndpoint: pendingAuthEndpoint,
        persistMode: loginPersistMode,
        bridgeUrl: bridgeUrl.trim() || undefined,
        bridgeSecret: bridgeSecret.trim() || undefined,
      });

      if (res.status === 'requires2fa') {
        setRequires2FA(true);
        setPendingGuid(res.guid);
        setPendingAuthEndpoint(res.authEndpoint);
        setAuthInfo(
          res.message ||
            'Введите 6-значный код двухфакторной аутентификации (2FA) с вашего iPhone или Mac.'
        );
        return;
      }

      if (res.status === 'authenticated' && res.token && res.session) {
        setPassword('');
        setTwoFactorCode('');
        setRequires2FA(false);
        setPendingGuid(undefined);
        setPendingAuthEndpoint(undefined);
        setAuthNeedsSapBridge(false);
        onAuthenticated(res.token, res.session);
        return;
      }

      setAuthNeedsSapBridge(Boolean(res.requiresSapBridge));
      setAuthError(res.message || 'Не удалось выполнить вход в Apple ID.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Ошибка соединения с сервером');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSessionTokenLogin = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError('');
    setAuthInfo('');
    setIsLoggingIn(true);

    try {
      const res = await apiLoginWithSessionToken({
        sessionString: sessionTokenInput,
        pin: sessionPinInput || undefined,
        persistMode: loginPersistMode,
      });

      if (res.status === 'authenticated' && res.token && res.session) {
        setSessionTokenInput('');
        setSessionPinInput('');
        setSessionNeedsPin(false);
        onAuthenticated(res.token, res.session);
        return;
      }

      if (res.needsPin) {
        setSessionNeedsPin(true);
      }
      setAuthError(res.message || 'Не удалось выполнить вход по токену сессии.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Ошибка проверки токена сессии');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleImportSessionFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result.trim() : '';
      if (text) {
        setSessionTokenInput(text);
        if (text.startsWith('ipav1.pin.')) {
          setSessionNeedsPin(true);
        }
        setAuthError('');
      }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  };

  const handleChangePolicy = async (nextMode: SessionPersistMode) => {
    if (!session) return;
    setIsUpdatingPolicy(true);
    setPolicyMessage('');
    setConfirmResetKeep(false);
    try {
      const res = await apiUpdateSessionPolicy(nextMode, authToken);
      if (res.ok && res.token && res.session) {
        onAuthenticated(res.token, res.session);
        const label =
          nextMode === 'keep'
            ? 'Сессия закреплена (режим «Не сбрасывать», до 30 дней).'
            : nextMode === '24h'
            ? 'Сессия сохранена в кэше браузера на 24 часа.'
            : 'Кэш браузера очищен — сессия активна только в текущей вкладке.';
        setPolicyMessage(label);
      }
    } catch (err) {
      setPolicyMessage(err instanceof Error ? err.message : 'Не удалось обновить режим сессии');
    } finally {
      setIsUpdatingPolicy(false);
    }
  };

  const handleGenerateSession = async () => {
    setIsGenerating(true);
    setPolicyMessage('');
    try {
      const res = await apiGenerateSessionToken(
        { durationMode: genDurationMode, pin: genPin.trim() || undefined },
        authToken
      );
      if (res.ok && res.sessionString && res.expiresAt) {
        setGeneratedSession({
          token: res.sessionString,
          expiresAt: res.expiresAt,
          pinProtected: Boolean(res.pinProtected),
        });
      } else {
        setPolicyMessage(res.error || 'Не удалось сгенерировать токен сессии.');
      }
    } catch (err) {
      setPolicyMessage(err instanceof Error ? err.message : 'Ошибка генерации сессии');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyGenerated = async () => {
    if (!generatedSession) return;
    try {
      await navigator.clipboard.writeText(generatedSession.token);
      setCopiedGen(true);
      setTimeout(() => setCopiedGen(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSignOutClick = () => {
    if (session?.persistMode === 'keep' && !confirmResetKeep) {
      setConfirmResetKeep(true);
      return;
    }
    setConfirmResetKeep(false);
    setGeneratedSession(null);
    onSignOut();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 text-balance">
            Аккаунт, сессии и Anisette
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
            После входа сессия автоматически кэшируется в браузере на 24 часа. Вы также можете закрепить её без сброса или сгенерировать переносимый токен для быстрого входа без 2FA.
          </p>
        </div>

        <button
          type="button"
          onClick={onToggleDarkMode}
          className="min-h-[42px] px-4 py-2 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#131822] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-2 self-start sm:self-auto whitespace-nowrap cursor-pointer"
        >
          {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          <span>{darkMode ? 'Светлая тема' : 'Тёмная тема'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Apple ID Auth OR Active Session & Generator */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-5">
            {session ? (
              <div className="space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>
                        Сессия активна · осталось {formatRemainingTime(session.expiresAt)}
                      </span>
                    </div>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-slate-50">
                      {session.accountName}
                    </h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
                      {session.email}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {confirmResetKeep && (
                      <button
                        type="button"
                        onClick={() => setConfirmResetKeep(false)}
                        className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                      >
                        Отмена
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleSignOutClick}
                      className="min-h-[42px] px-4 py-2 text-sm font-medium rounded-xl border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors inline-flex items-center gap-2 whitespace-nowrap cursor-pointer"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>
                        {confirmResetKeep
                          ? 'Точно сбросить и выйти?'
                          : session.persistMode === 'keep'
                          ? 'Сбросить сессию'
                          : 'Выйти'}
                      </span>
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-slate-100 dark:border-slate-800/80 text-xs">
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">DSID</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                      {session.dsid}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">Apple Pod</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      p{session.pod}-buy.itunes.apple.com
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">Режим хранения</div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      {session.persistMode === 'keep'
                        ? 'Не сбрасывать (30 дн.)'
                        : session.persistMode === '24h'
                        ? 'Кэш браузера (24 ч)'
                        : 'Только эта вкладка'}
                    </div>
                  </div>
                </div>

                {/* Browser Cache & Do Not Reset Settings */}
                <div className="pt-4 border-t border-slate-100 dark:border-slate-800/80 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Хранение сессии в браузере
                    </span>
                    {isUpdatingPolicy && <Loader2 className="w-4 h-4 animate-spin text-[#0066FF]" />}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {(
                      [
                        { id: '24h', label: 'Кэш 24 часа', sub: 'Автоматически' },
                        { id: 'keep', label: 'Не сбрасывать', sub: 'Закрепить на 30 дн.' },
                        { id: 'memory', label: 'Без кэша', sub: 'До закрытия вкладки' },
                      ] as const
                    ).map((opt) => {
                      const active = session.persistMode === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={isUpdatingPolicy}
                          onClick={() => handleChangePolicy(opt.id)}
                          className={`min-h-[54px] px-3.5 py-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                            active
                              ? 'border-[#0066FF] bg-[#0066FF]/[0.06] dark:bg-[#0066FF]/15'
                              : 'border-slate-200 dark:border-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600'
                          }`}
                        >
                          <div
                            className={`text-xs font-semibold ${
                              active
                                ? 'text-[#0066FF] dark:text-blue-400'
                                : 'text-slate-900 dark:text-slate-100'
                            }`}
                          >
                            {opt.label}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {opt.sub}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {policyMessage && (
                    <p className="text-xs text-emerald-700 dark:text-emerald-400">
                      {policyMessage}
                    </p>
                  )}
                </div>

                {/* Portable Session Generator */}
                <div className="pt-4 border-t border-slate-100 dark:border-slate-800/80 space-y-3.5">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <KeyRound className="w-4 h-4 text-[#0066FF]" />
                      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                        Генерация сессии для повторного входа
                      </h3>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Создайте зашифрованный ключ сессии, чтобы позже войти через вкладку «Вход по сессии» на iPhone или другом браузере без пароля и 2FA.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label
                        htmlFor="gen-duration"
                        className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                      >
                        Срок действия токена
                      </label>
                      <select
                        id="gen-duration"
                        value={genDurationMode}
                        onChange={(e) =>
                          setGenDurationMode(e.target.value === '24h' ? '24h' : 'keep')
                        }
                        className="w-full min-h-[42px] px-3 py-2 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                      >
                        <option value="keep">Не сбрасывать (30 дней)</option>
                        <option value="24h">На сутки (24 часа)</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor="gen-pin"
                        className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                      >
                        PIN-защита токена (опционально)
                      </label>
                      <input
                        id="gen-pin"
                        type="password"
                        value={genPin}
                        onChange={(e) => setGenPin(e.target.value.slice(0, 32))}
                        placeholder="Без PIN"
                        className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={handleGenerateSession}
                    className="min-h-[44px] px-4 py-2 text-sm font-semibold rounded-xl bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-white disabled:opacity-60 transition-colors inline-flex items-center gap-2 cursor-pointer"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Генерация…</span>
                      </>
                    ) : (
                      <>
                        <KeyRound className="w-4 h-4" />
                        <span>Сгенерировать токен сессии</span>
                      </>
                    )}
                  </button>

                  {generatedSession && (
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700/80 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-1.5">
                          {generatedSession.pinProtected && <Lock className="w-3.5 h-3.5 text-[#0066FF]" />}
                          <span>
                            Готово · действует {formatRemainingTime(generatedSession.expiresAt)}
                          </span>
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleCopyGenerated}
                            className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-medium inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            {copiedGen ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                                <span>Скопировано</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Копировать</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              downloadTextFile(
                                `ipavault-session-${session.dsid}.txt`,
                                generatedSession.token,
                                'text/plain'
                              )
                            }
                            className="min-h-[34px] px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 font-medium inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Сохранить .txt</span>
                          </button>
                        </div>
                      </div>
                      <textarea
                        readOnly
                        rows={3}
                        value={generatedSession.token}
                        onFocus={(e) => e.currentTarget.select()}
                        className="w-full p-2.5 text-[11px] font-mono break-all rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {/* Login Mode Segmented Control */}
                <div className="inline-flex items-center p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
                  <button
                    type="button"
                    onClick={() => {
                      setLoginTab('credentials');
                      setAuthError('');
                      setAuthInfo('');
                    }}
                    className={`min-h-[38px] px-4 py-1.5 text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                      loginTab === 'credentials'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    Apple ID и пароль
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLoginTab('session');
                      setAuthError('');
                      setAuthInfo('');
                    }}
                    className={`min-h-[38px] px-4 py-1.5 text-xs sm:text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                      loginTab === 'session'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    Вход по сессии
                  </button>
                </div>

                {loginTab === 'credentials' ? (
                  <form onSubmit={handleCredentialsLogin} className="space-y-4">
                    <div className="space-y-1">
                      <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">
                        Вход в Apple ID
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        Ключ шифрования создаётся автоматически в защищённых <span className="font-mono">HttpOnly</span>-cookie браузера — сессия сохраняется на 24 часа и работает на Vercel без ручной настройки.
                      </p>
                    </div>

                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="apple-email"
                          className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                        >
                          Apple ID (e-mail)
                        </label>
                        <input
                          id="apple-email"
                          type="email"
                          required
                          autoComplete="username"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="name@icloud.com"
                          className="w-full min-h-[44px] px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label
                          htmlFor="apple-password"
                          className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                        >
                          Пароль Apple ID
                        </label>
                        <div className="relative">
                          <input
                            id="apple-password"
                            type={showPassword ? 'text' : 'password'}
                            required
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••••••"
                            className="w-full min-h-[44px] pl-3.5 pr-11 py-2.5 text-sm bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
                          />
                          <button
                            type="button"
                            aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                          >
                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {requires2FA && (
                        <div className="space-y-1.5 pt-1">
                          <label
                            htmlFor="apple-2fa"
                            className="block text-xs font-semibold text-[#0066FF] dark:text-blue-400"
                          >
                            Код двухфакторной аутентификации (6 цифр)
                          </label>
                          <input
                            id="apple-2fa"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            required
                            value={twoFactorCode}
                            onChange={(e) =>
                              setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                            }
                            placeholder="123456"
                            className="w-full min-h-[48px] px-4 py-2.5 text-lg font-mono tracking-[0.35em] text-center bg-slate-50 dark:bg-slate-900/70 border border-[#0066FF] rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
                          />
                        </div>
                      )}

                      {/* Automatic 24h vs Do Not Reset Option */}
                      <div className="pt-1 space-y-1.5">
                        <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          Кэширование сессии в браузере
                        </span>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {(
                            [
                              ['24h', 'На сутки (24 ч)'],
                              ['keep', 'Не сбрасывать (30 дн.)'],
                              ['memory', 'Не сохранять'],
                            ] as [SessionPersistMode, string][]
                          ).map(([mode, label]) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setLoginPersistMode(mode)}
                              className={`min-h-[40px] px-3 py-2 text-xs font-medium rounded-xl border transition-colors cursor-pointer ${
                                loginPersistMode === mode
                                  ? 'border-[#0066FF] bg-[#0066FF]/[0.06] dark:bg-[#0066FF]/15 text-[#0066FF] dark:text-blue-400'
                                  : 'border-slate-200 dark:border-slate-700/80 text-slate-600 dark:text-slate-400 hover:border-slate-300'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {authInfo && (
                      <div className="p-3.5 rounded-xl bg-blue-50 dark:bg-blue-950/35 border border-blue-200 dark:border-blue-900/60 text-xs text-blue-900 dark:text-blue-200">
                        {authInfo}
                      </div>
                    )}

                    {authError && (
                      <div
                        role="alert"
                        className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/35 border border-rose-200 dark:border-rose-900/60 space-y-2.5 text-xs text-rose-800 dark:text-rose-200"
                      >
                        <div className="flex items-start gap-2.5">
                          <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                          <span className="leading-relaxed">{authError}</span>
                        </div>
                        {authNeedsSapBridge && (
                          <div className="pl-6 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setLoginTab('session');
                                setAuthError('');
                                setAuthNeedsSapBridge(false);
                              }}
                              className="min-h-[34px] px-3 py-1 rounded-lg bg-rose-700 hover:bg-rose-800 text-white font-semibold transition-colors cursor-pointer"
                            >
                              Открыть «Вход по сессии»
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2.5 pt-1">
                      <button
                        type="submit"
                        disabled={isLoggingIn}
                        className="min-h-[46px] px-6 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] disabled:opacity-60 text-white transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                      >
                        {isLoggingIn ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>{requires2FA ? 'Проверка кода 2FA…' : 'Подключение к Apple ID…'}</span>
                          </>
                        ) : (
                          <span>{requires2FA ? 'Подтвердить код 2FA' : 'Войти в Apple ID'}</span>
                        )}
                      </button>

                      {requires2FA && (
                        <button
                          type="button"
                          onClick={() => {
                            setRequires2FA(false);
                            setTwoFactorCode('');
                            setPendingGuid(undefined);
                            setPendingAuthEndpoint(undefined);
                            setAuthInfo('');
                            setAuthError('');
                          }}
                          className="min-h-[46px] px-4 py-2.5 text-sm font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 cursor-pointer"
                        >
                          Сбросить 2FA
                        </button>
                      )}
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleSessionTokenLogin} className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">
                          Вход по сохранённой сессии
                        </h2>
                        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                          Вставьте токен <span className="font-mono">ipav1…</span> (сгенерированный в IPA Vault) или JSON-сессию из <span className="font-mono">ipatool</span>, чтобы войти мгновенно без пароля и 2FA.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => sessionFileRef.current?.click()}
                        className="min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        <span>Из файла</span>
                      </button>
                      <input
                        ref={sessionFileRef}
                        type="file"
                        accept=".txt,.session,text/plain"
                        onChange={handleImportSessionFile}
                        className="hidden"
                      />
                    </div>

                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="session-token-input"
                          className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                        >
                          Токен сессии (ipav1…)
                        </label>
                        <textarea
                          id="session-token-input"
                          required
                          rows={4}
                          spellCheck={false}
                          value={sessionTokenInput}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSessionTokenInput(val);
                            if (val.trim().startsWith('ipav1.pin.')) {
                              setSessionNeedsPin(true);
                            }
                          }}
                          placeholder="ipav1.open...."
                          className="w-full p-3 text-xs font-mono break-all bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
                        />
                      </div>

                      {(sessionNeedsPin || sessionTokenInput.trim().startsWith('ipav1.pin.')) && (
                        <div className="space-y-1.5">
                          <label
                            htmlFor="session-pin-input"
                            className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                          >
                            PIN-код от токена сессии
                          </label>
                          <input
                            id="session-pin-input"
                            type="password"
                            required={sessionTokenInput.trim().startsWith('ipav1.pin.')}
                            value={sessionPinInput}
                            onChange={(e) => setSessionPinInput(e.target.value)}
                            placeholder="Введите PIN"
                            className="w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-slate-50 dark:bg-slate-900/70 border border-[#0066FF] rounded-xl text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30"
                          />
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                          Сохранить в этом браузере
                        </span>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {(
                            [
                              ['24h', 'На сутки (24 ч)'],
                              ['keep', 'Не сбрасывать (30 дн.)'],
                              ['memory', 'Только вкладка'],
                            ] as [SessionPersistMode, string][]
                          ).map(([mode, label]) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setLoginPersistMode(mode)}
                              className={`min-h-[40px] px-3 py-2 text-xs font-medium rounded-xl border transition-colors cursor-pointer ${
                                loginPersistMode === mode
                                  ? 'border-[#0066FF] bg-[#0066FF]/[0.06] dark:bg-[#0066FF]/15 text-[#0066FF] dark:text-blue-400'
                                  : 'border-slate-200 dark:border-slate-700/80 text-slate-600 dark:text-slate-400 hover:border-slate-300'
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {authError && (
                      <div
                        role="alert"
                        className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/35 border border-rose-200 dark:border-rose-900/60 flex items-start gap-2.5 text-xs text-rose-800 dark:text-rose-200"
                      >
                        <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                        <span>{authError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={isLoggingIn}
                      className="min-h-[46px] px-6 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] disabled:opacity-60 text-white transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                    >
                      {isLoggingIn ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Восстановление сессии…</span>
                        </>
                      ) : (
                        <>
                          <KeyRound className="w-4 h-4" />
                          <span>Войти по сессии</span>
                        </>
                      )}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right: FairPlay SAP Bridge + SideStore Anisette */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[#0066FF]" />
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
                  FairPlay SAP Bridge
                </h2>
              </div>
              {(envBridgeConfigured || bridgeUrl.trim().startsWith('https://')) && (
                <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                  {envBridgeConfigured && !bridgeUrl.trim() ? 'Vercel Env' : 'Подключён'}
                </span>
              )}
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Для прямого входа по Apple ID + 2FA с Vercel Apple требует нативную подпись{' '}
              <span className="font-mono">FairPlay SAP (CoreFP)</span>. Разверните Docker-контейнер из папки{' '}
              <span className="font-mono">companion/</span> на Render / Railway / VPS и укажите его адрес ниже (или в{' '}
              <span className="font-mono">SAP_BRIDGE_URL</span> на Vercel).
            </p>

            {envBridgeConfigured && !bridgeUrl.trim() && (
              <div className="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/60 text-xs text-emerald-900 dark:text-emerald-200">
                Мост автоматически подключён через переменную окружения{' '}
                <span className="font-mono font-semibold">SAP_BRIDGE_URL</span> на Vercel.
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="sap-bridge-url"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  HTTPS-адрес моста (опционально)
                </label>
                <input
                  id="sap-bridge-url"
                  type="url"
                  value={bridgeUrl}
                  onChange={(e) => {
                    setBridgeUrl(e.target.value);
                    saveBridgeConfig(e.target.value, bridgeSecret);
                  }}
                  placeholder="https://ipa-sap-bridge.onrender.com"
                  className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sap-bridge-secret"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  Ключ доступа BRIDGE_SECRET (если задан)
                </label>
                <input
                  id="sap-bridge-secret"
                  type="password"
                  value={bridgeSecret}
                  onChange={(e) => {
                    setBridgeSecret(e.target.value);
                    saveBridgeConfig(bridgeUrl, e.target.value);
                  }}
                  placeholder="Опционально"
                  className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                />
              </div>

              <button
                type="button"
                disabled={isTestingBridge}
                onClick={handleTestBridge}
                className="w-full min-h-[42px] px-4 py-2 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isTestingBridge ? 'animate-spin' : ''}`} />
                <span>Проверить FairPlay SAP Bridge</span>
              </button>

              {bridgeResult && (
                <div
                  className={`p-3 rounded-xl border text-xs ${
                    bridgeResult.ok
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-900 dark:text-emerald-200'
                      : 'bg-rose-50 dark:bg-rose-950/35 border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-200'
                  }`}
                >
                  {bridgeResult.ok ? (
                    <div className="space-y-0.5">
                      <div className="font-semibold">
                        Мост {bridgeResult.engine} готов к работе
                      </div>
                      <div className="font-mono tabular-nums opacity-85">
                        Задержка: {bridgeResult.latencyMs} мс
                      </div>
                    </div>
                  ) : (
                    <span>{bridgeResult.error}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-[#0066FF]" />
              <h2 className="text-base font-bold text-slate-900 dark:text-slate-50">
                SideStore Anisette (Failover)
              </h2>
            </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Параллельно опрашивает до 4 серверов <span className="font-mono">SideStore/anisette-servers</span> одновременно и выбирает самый быстрый ответ для стабильной авторизации Apple ID.
          </p>

          <label className="flex items-center gap-3 min-h-[44px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={useAnisette}
              onChange={(e) => setUseAnisette(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 accent-[#0066FF]"
            />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Использовать Anisette при входе
            </span>
          </label>

          {useAnisette && (
            <div className="space-y-3 pt-1">
              <div className="space-y-1.5">
                <label
                  htmlFor="anisette-select"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  Приоритетный сервер
                </label>
                <select
                  id="anisette-select"
                  value={selectedServer}
                  onChange={(e) => setSelectedServer(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                >
                  {servers.map((srv) => (
                    <option key={srv.address} value={srv.address}>
                      {srv.name} ({srv.address.replace('https://', '')})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="anisette-custom"
                  className="block text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  Свой HTTPS-сервер (опционально)
                </label>
                <input
                  id="anisette-custom"
                  type="url"
                  value={customAnisetteUrl}
                  onChange={(e) => setCustomAnisetteUrl(e.target.value)}
                  placeholder="https://ani.example.com"
                  className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                />
              </div>

              <button
                type="button"
                disabled={isTestingAnisette}
                onClick={handleTestAnisette}
                className="w-full min-h-[42px] px-4 py-2 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isTestingAnisette ? 'animate-spin' : ''}`} />
                <span>Проверить соединение Anisette</span>
              </button>

              {anisetteResult && (
                <div
                  className={`p-3 rounded-xl border text-xs ${
                    anisetteResult.ok
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/60 text-emerald-900 dark:text-emerald-200'
                      : 'bg-rose-50 dark:bg-rose-950/35 border-rose-200 dark:border-rose-900/60 text-rose-800 dark:text-rose-200'
                  }`}
                >
                  {anisetteResult.ok ? (
                    <div className="space-y-0.5">
                      <div className="font-semibold inline-flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>{anisetteResult.serverName} ответил</span>
                      </div>
                      <div className="font-mono tabular-nums opacity-85">
                        Задержка: {anisetteResult.latencyMs} мс · Machine ID: {anisetteResult.machineIdPreview}
                      </div>
                    </div>
                  ) : (
                    <span>{anisetteResult.error}</span>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
