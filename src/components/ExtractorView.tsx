import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Globe,
  History,
  KeyRound,
  Loader2,
  ShoppingBag,
  Smartphone,
  XCircle,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import {
  apiInspectApp,
  apiPurchaseFreeLicense,
  buildItmsServicesUrl,
  buildQrHandoffUrl,
  downloadTextFile,
  isIosDevice,
  triggerDirectFileDownload,
} from '../lib/api.ts';
import { extractNumericAppID, formatBytes } from '../shared/parsers.ts';
import type {
  AppleSessionSummary,
  DownloadDescriptorResult,
  InspectAppResponse,
  SavedIpaRecord,
} from '../shared/types.ts';
import { AppIcon } from './AppIcon.tsx';
import { QrCodeBox } from './QrCodeBox.tsx';

interface ExtractorViewProps {
  initialAppInput: string;
  initialVersionInput: string;
  initialTitleHint?: string;
  authToken: string | null;
  session: AppleSessionSummary | null;
  onSessionExpired: () => void;
  onOpenAccount: () => void;
  onRecordSaved: (record: SavedIpaRecord) => void;
}

export function ExtractorView({
  initialAppInput,
  initialVersionInput,
  initialTitleHint,
  authToken,
  session,
  onSessionExpired,
  onOpenAccount,
  onRecordSaved,
}: ExtractorViewProps) {
  const [appInput, setAppInput] = useState(initialAppInput);
  const [versionInput, setVersionInput] = useState(initialVersionInput);
  const [installOnIphone, setInstallOnIphone] = useState<boolean>(() => isIosDevice());
  const [isLoading, setIsLoading] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [noticeText, setNoticeText] = useState('');
  const [result, setResult] = useState<InspectAppResponse | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const onIos = isIosDevice();

  // Sync external selection (from Popular Lists or Search) and inspect automatically
  useEffect(() => {
    if (initialAppInput && initialAppInput !== appInput) {
      setAppInput(initialAppInput);
      setVersionInput(initialVersionInput);
      void runInspect(initialAppInput, initialVersionInput);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAppInput, initialVersionInput]);

  async function runInspect(rawInput = appInput, rawVersion = versionInput) {
    const cleanId = extractNumericAppID(rawInput);
    if (!cleanId) {
      setErrorText('Введите корректный App ID (например, 481627348) или ссылку на App Store.');
      return;
    }

    const cleanVer = rawVersion.trim().replace(/[^\d]/g, '');
    setIsLoading(true);
    setErrorText('');
    setNoticeText('');

    try {
      const data = await apiInspectApp({
        appID: cleanId,
        externalVersionID: cleanVer,
        authToken,
      });
      setResult(data);

      // Never auto-sign-out the user on a per-app inspect failure; let them review
      // the warning or manually re-authenticate on the Account tab if needed.
      if (data.sessionExpired) {
        setErrorText(
          data.warning ||
            'Apple запросил подтверждение сессии для этого приложения. Вы можете повторить попытку или обновить вход на вкладке «Аккаунт».'
        );
      }

      if (data.descriptor) {
        const d = data.descriptor;
        onRecordSaved({
          id: `${d.appID}-${d.externalVersionID}-${Date.now()}`,
          appID: d.appID,
          appName: d.appName || initialTitleHint || `App ${d.appID}`,
          bundleID: d.bundleID,
          version: d.version,
          externalVersionID: d.externalVersionID,
          directCdnUrl: d.directCdnUrl,
          manifestPath: d.manifestPath,
          iconURL: d.iconURL || data.storeItem?.artworkUrl512 || data.storeItem?.artworkUrl100,
          minOSVersion: d.minOSVersion || data.storeItem?.minimumOsVersion,
          fileSizeBytes: d.fileSizeBytes,
          md5: d.md5,
          sinfCount: d.sinfCount,
          metadataPlistXml: d.metadataPlistXml,
          isDeletedDirect: d.isDeletedDirect,
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Ошибка запроса к App Store');
    } finally {
      setIsLoading(false);
    }
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runInspect();
  };

  const handlePurchase = async () => {
    if (!session || !result) return;
    setIsPurchasing(true);
    setErrorText('');
    setNoticeText('');
    try {
      const res = await apiPurchaseFreeLicense(result.appID, authToken);
      if (res.sessionExpired) {
        setErrorText(
          'Apple запросил повторную авторизацию для покупки лицензии — обновите вход на вкладке «Аккаунт».'
        );
        return;
      }
      if (!res.ok) {
        setErrorText(res.error || 'Не удалось приобрести бесплатную лицензию.');
        return;
      }
      setNoticeText(res.message || 'Бесплатная лицензия добавлена. Запрашиваем IPA с серверов Apple…');
      await runInspect(result.appID, versionInput);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Ошибка при покупке лицензии');
    } finally {
      setIsPurchasing(false);
    }
  };

  const handlePrimaryAction = (descriptor: DownloadDescriptorResult) => {
    if (installOnIphone) {
      const itmsUrl = buildItmsServicesUrl(descriptor.manifestPath);
      window.location.href = itmsUrl;
      setNoticeText(
        onIos
          ? 'Запрос на установку отправлен в iOS. Подтвердите установку во всплывающем окне и проверьте экран «Домой».'
          : 'Отправлена ссылка itms-services://. Если вы на компьютере, отсканируйте QR-код камерой iPhone ниже.'
      );
    } else {
      const safeName = descriptor.appName
        .replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32);
      const filename = `${safeName || 'App'}-${descriptor.appID}-${descriptor.externalVersionID}.ipa`;
      triggerDirectFileDownload(descriptor.directCdnUrl, filename);
      setNoticeText('Прямая загрузка .ipa с серверов Apple запущена в браузере.');
    }
  };

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // Clipboard may be blocked in restricted contexts
    }
  };

  const descriptor = result?.descriptor;
  const resolvedName =
    descriptor?.appName ||
    result?.storeItem?.trackName ||
    (result ? initialTitleHint || `App ${result.appID}` : '');
  const resolvedIcon =
    descriptor?.iconURL ||
    result?.storeItem?.artworkUrl512 ||
    result?.storeItem?.artworkUrl100;
  const resolvedBundleId = descriptor?.bundleID || result?.storeItem?.bundleId;
  const resolvedMinOs = descriptor?.minOSVersion || result?.storeItem?.minimumOsVersion;
  const resolvedSize =
    descriptor?.fileSizeBytes ||
    (result?.storeItem?.fileSizeBytes ? Number(result.storeItem.fileSizeBytes) : undefined);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 text-balance">
          Загрузка IPA и установка на iPhone
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
          Получайте прямые ссылки на <span className="font-mono">.ipa</span> с серверов Apple по App ID или ссылке App Store, включая удалённые приложения и прошлые версии.
        </p>
      </div>

      {/* Input Form */}
      <form
        onSubmit={handleSubmit}
        className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-4 sm:p-5"
      >
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6 space-y-1.5">
            <label
              htmlFor="app-id-input"
              className="block text-xs font-medium text-slate-600 dark:text-slate-400"
            >
              App ID или ссылка App Store
            </label>
            <input
              id="app-id-input"
              type="text"
              value={appInput}
              onChange={(e) => setAppInput(e.target.value)}
              placeholder="481627348 или https://apps.apple.com/ru/app/.../id..."
              className="w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
            />
          </div>

          <div className="md:col-span-4 space-y-1.5">
            <label
              htmlFor="ext-ver-input"
              className="block text-xs font-medium text-slate-600 dark:text-slate-400"
            >
              External Version ID (опционально)
            </label>
            <input
              id="ext-ver-input"
              type="text"
              inputMode="numeric"
              value={versionInput}
              onChange={(e) => setVersionInput(e.target.value)}
              placeholder="Последняя версия"
              className="w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-700/80 rounded-xl text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0066FF]/30 focus:border-[#0066FF]"
            />
          </div>

          <div className="md:col-span-2 flex items-end">
            <button
              type="submit"
              disabled={isLoading}
              className="w-full min-h-[44px] px-4 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] disabled:opacity-60 text-white transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Запрос…</span>
                </>
              ) : (
                <span>Получить IPA</span>
              )}
            </button>
          </div>
        </div>

        {/* Immediate Install Mode Checkbox + Quick Examples */}
        <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <label
            htmlFor="install-iphone-mode-top"
            className="inline-flex items-center gap-2.5 min-h-[40px] text-sm font-medium text-slate-800 dark:text-slate-200 cursor-pointer select-none"
          >
            <input
              id="install-iphone-mode-top"
              type="checkbox"
              checked={installOnIphone}
              onChange={(e) => setInstallOnIphone(e.target.checked)}
              className="w-4.5 h-4.5 rounded border-slate-300 text-[#0066FF] focus:ring-[#0066FF] accent-[#0066FF] cursor-pointer"
            />
            <span>Установить приложение на iPhone (OTA с серверов Apple)</span>
          </label>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span>Примеры:</span>
            {[
              { name: '2ГИС', id: '481627348' },
              { name: 'Telegram', id: '686449807' },
              { name: 'СберБанк', id: '6769745089' },
              { name: 'Т-Банк', id: '6785551921' },
            ].map((sample) => (
              <button
                key={sample.id}
                type="button"
                onClick={() => {
                  setAppInput(sample.id);
                  setVersionInput('');
                  void runInspect(sample.id, '');
                }}
                className="text-slate-700 dark:text-slate-300 hover:text-[#0066FF] dark:hover:text-blue-400 underline underline-offset-2 cursor-pointer"
              >
                {sample.name}
              </button>
            ))}
          </div>
        </div>
      </form>

      {errorText && (
        <div
          role="alert"
          className="bg-rose-50 dark:bg-rose-950/35 border border-rose-200 dark:border-rose-900/60 rounded-2xl p-4 flex items-start gap-3 text-sm text-rose-800 dark:text-rose-200"
        >
          <AlertCircle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
          <p>{errorText}</p>
        </div>
      )}

      {noticeText && (
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/60 rounded-2xl p-4 flex items-start gap-3 text-sm text-emerald-900 dark:text-emerald-200">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <p>{noticeText}</p>
        </div>
      )}

      {/* Workspace 2-Column Result */}
      {result && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: App Details + Version History */}
          <div className="lg:col-span-7 space-y-6">
            {/* App Identity Header */}
            <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-start gap-4">
                <AppIcon
                  src={resolvedIcon}
                  name={resolvedName}
                  seed={result.appID}
                  size="lg"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <h2 className="text-xl font-bold text-slate-900 dark:text-slate-50 leading-snug">
                    {resolvedName}
                  </h2>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    {result.storeItem?.artistName && (
                      <>
                        <span className="text-slate-700 dark:text-slate-300 font-medium">
                          {result.storeItem.artistName}
                        </span>
                        <span aria-hidden="true">·</span>
                      </>
                    )}
                    <span className="font-mono">ID {result.appID}</span>
                    {resolvedBundleId && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono truncate max-w-[260px]">
                          {resolvedBundleId}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs pt-0.5">
                    {result.availability === 'availableRU' && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        В App Store (RU)
                      </span>
                    )}
                    {result.availability === 'deletedInRUAvailableUS' && (
                      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-medium">
                        <Globe className="w-3.5 h-3.5" />
                        Удалено в RU · доступно в US
                      </span>
                    )}
                    {result.availability === 'deletedGlobally' && (
                      <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400 font-medium">
                        <XCircle className="w-3.5 h-3.5" />
                        Удалено из App Store (прямая выгрузка)
                      </span>
                    )}
                    {resolvedMinOs && (
                      <>
                        <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-slate-600 dark:text-slate-400 font-mono">
                          iOS {resolvedMinOs}+
                        </span>
                      </>
                    )}
                    {resolvedSize && (
                      <>
                        <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
                          ·
                        </span>
                        <span className="text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                          {formatBytes(resolvedSize)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {descriptor && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 border-t border-slate-100 dark:border-slate-800/80 text-xs">
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">Версия</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5">
                      {descriptor.version}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">External ID</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                      {descriptor.externalVersionID || '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">Размер IPA</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                      {formatBytes(descriptor.fileSizeBytes)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 dark:text-slate-500">Подписи SINF</div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-slate-100 mt-0.5 tabular-nums">
                      {descriptor.sinfCount} шт.
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Historical Versions Picker */}
            <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    История версий ({result.versions.length})
                  </h3>
                </div>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  Нажмите на сборку для выбора
                </span>
              </div>

              {result.versions.length === 0 ? (
                <div className="px-5 py-8 text-sm text-slate-500 dark:text-slate-400 text-center">
                  Публичная история версий не найдена. Вы можете ввести External Version ID вручную выше.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800/80 max-h-[380px] overflow-y-auto">
                  {result.versions.slice(0, 50).map((ver) => {
                    const isActive =
                      descriptor?.externalVersionID === ver.externalVersionID ||
                      versionInput === ver.externalVersionID;
                    return (
                      <li key={ver.externalVersionID}>
                        <button
                          type="button"
                          onClick={() => {
                            setVersionInput(ver.externalVersionID);
                            void runInspect(result.appID, ver.externalVersionID);
                          }}
                          className={`w-full min-h-[48px] px-5 py-2.5 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer ${
                            isActive
                              ? 'bg-[#0066FF]/8 dark:bg-[#0066FF]/15'
                              : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <div className="min-w-0 flex items-center gap-3">
                            <span
                              className={`font-mono text-sm font-semibold tabular-nums ${
                                isActive
                                  ? 'text-[#0066FF] dark:text-blue-400'
                                  : 'text-slate-900 dark:text-slate-100'
                              }`}
                            >
                              {ver.bundleVersion ? `v${ver.bundleVersion}` : 'Сборка'}
                            </span>
                            <span className="font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                              {ver.externalVersionID}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums shrink-0">
                            {ver.sizeBytes ? <span>{formatBytes(ver.sizeBytes)}</span> : null}
                            {ver.createdAt ? (
                              <span className="hidden sm:inline">
                                {ver.createdAt.slice(0, 10)}
                              </span>
                            ) : null}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Right Column: Direct Apple Download & iPhone Install Panel */}
          <div className="lg:col-span-5 space-y-4">
            <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-5">
              {descriptor ? (
                <>
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-50">
                      Загрузка напрямую с серверов Apple
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      Файл отдаётся напрямую с официального CDN Apple на максимальной скорости телефона или ПК без проксирования.
                    </p>
                  </div>

                  {/* THE REQUESTED CHECKBOX: Install App on iPhone */}
                  <label
                    htmlFor="install-iphone-checkbox"
                    className={`flex items-start gap-3.5 p-3.5 rounded-xl border transition-colors cursor-pointer select-none min-h-[56px] ${
                      installOnIphone
                        ? 'border-[#0066FF] bg-[#0066FF]/[0.05] dark:bg-[#0066FF]/15'
                        : 'border-slate-200 dark:border-slate-700/80 hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
                  >
                    <input
                      id="install-iphone-checkbox"
                      type="checkbox"
                      checked={installOnIphone}
                      onChange={(e) => setInstallOnIphone(e.target.checked)}
                      className="mt-0.5 w-5 h-5 rounded border-slate-300 text-[#0066FF] focus:ring-[#0066FF] shrink-0 cursor-pointer accent-[#0066FF]"
                    />
                    <div className="space-y-0.5">
                      <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                        Установить приложение на iPhone
                      </span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                        Устанавливает приложение напрямую с серверов Apple через OTA-манифест (<span className="font-mono">itms-services://</span>). Если снять галку — скачается файл <span className="font-mono">.ipa</span>.
                      </span>
                    </div>
                  </label>

                  {/* Primary Action CTA */}
                  <button
                    type="button"
                    onClick={() => handlePrimaryAction(descriptor)}
                    className="w-full min-h-[50px] px-5 py-3 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] active:scale-[0.99] text-white transition-all inline-flex items-center justify-center gap-2.5 cursor-pointer"
                  >
                    {installOnIphone ? (
                      <>
                        <Smartphone className="w-4 h-4 shrink-0" />
                        <span>Установить приложение на iPhone</span>
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4 shrink-0" />
                        <span>Скачать IPA с серверов Apple</span>
                      </>
                    )}
                  </button>

                  {/* Desktop QR Code Handoff when OTA Install Checkbox is Enabled */}
                  {installOnIphone && !onIos && (
                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800/80 flex flex-col items-center space-y-3">
                      <QrCodeBox
                        value={buildQrHandoffUrl(descriptor.manifestToken, resolvedName)}
                        caption="Наведите камеру iPhone на QR-код, чтобы открыть прямую установку с серверов Apple в Safari"
                      />
                    </div>
                  )}

                  {/* Secondary Action Utilities */}
                  <div className="pt-4 border-t border-slate-100 dark:border-slate-800/80 space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          copyText(
                            'cdn',
                            installOnIphone
                              ? buildItmsServicesUrl(descriptor.manifestPath)
                              : descriptor.directCdnUrl
                          )
                        }
                        className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        {copiedKey === 'cdn' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Скопировано</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>
                              {installOnIphone ? 'Копировать OTA-ссылку' : 'Копировать CDN URL'}
                            </span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          downloadTextFile(
                            `iTunesMetadata-${descriptor.appID}.plist`,
                            descriptor.metadataPlistXml
                          )
                        }
                        className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <FileCode2 className="w-3.5 h-3.5" />
                        <span>iTunesMetadata.plist</span>
                      </button>
                    </div>

                    {installOnIphone && (
                      <button
                        type="button"
                        onClick={() =>
                          triggerDirectFileDownload(
                            descriptor.directCdnUrl,
                            `${descriptor.bundleID}-${descriptor.version}.ipa`
                          )
                        }
                        className="w-full min-h-[40px] px-3.5 py-2 text-xs font-medium rounded-xl text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Или скачать чистый .ipa файл напрямую</span>
                      </button>
                    )}

                    <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed pt-1">
                      Источник Apple: <span className="font-mono">{descriptor.endpointUsed}</span>. Для OTA-установки на iPhone должен быть выполнен вход в тот же Apple ID, либо установите скачанный <span className="font-mono">.ipa</span> через SideStore / AltStore / TrollStore / Sideloadly.
                    </p>
                  </div>
                </>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-50">
                      {!session
                        ? 'Войдите в Apple ID для скачивания'
                        : result.licenseRequired
                        ? 'Требуется лицензия на аккаунте'
                        : 'Прямая ссылка недоступна'}
                    </h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                      {result.warning ||
                        'Авторизуйтесь под своим Apple ID, чтобы запросить подписанную ссылку IPA напрямую с серверов Apple.'}
                    </p>
                  </div>

                  {!session || result.sessionExpired ? (
                    <button
                      type="button"
                      onClick={onOpenAccount}
                      className="w-full min-h-[48px] px-4 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] text-white transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <KeyRound className="w-4 h-4" />
                      <span>{result.sessionExpired ? 'Обновить вход в Apple ID' : 'Войти в Apple ID'}</span>
                    </button>
                  ) : (
                    result.availability !== 'deletedGlobally' && (
                      <button
                        type="button"
                        disabled={isPurchasing}
                        onClick={handlePurchase}
                        className="w-full min-h-[48px] px-4 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] disabled:opacity-60 text-white transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                      >
                        {isPurchasing ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Добавление лицензии…</span>
                          </>
                        ) : (
                          <>
                            <ShoppingBag className="w-4 h-4" />
                            <span>Приобрести бесплатную лицензию</span>
                          </>
                        )}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
