import {
  Download,
  FileCode2,
  QrCode,
  Smartphone,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import {
  buildItmsServicesUrl,
  buildQrHandoffUrl,
  downloadTextFile,
  triggerDirectFileDownload,
} from '../lib/api.ts';
import { formatBytes } from '../shared/parsers.ts';
import type { SavedIpaRecord } from '../shared/types.ts';
import { AppIcon } from './AppIcon.tsx';
import { QrCodeBox } from './QrCodeBox.tsx';

interface HistoryViewProps {
  records: SavedIpaRecord[];
  onDelete: (id: string) => void;
  onOpenExtractor: (appId: string, versionId: string) => void;
}

export function HistoryView({ records, onDelete, onOpenExtractor }: HistoryViewProps) {
  const [expandedQrId, setExpandedQrId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 text-balance">
          Полученные IPA ({records.length})
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Быстрый доступ к недавно полученным ссылкам с серверов Apple, OTA-установке на iPhone и файлам <span className="font-mono">iTunesMetadata.plist</span>.
        </p>
      </div>

      <div className="bg-white dark:bg-[#131822] border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
        {records.length === 0 ? (
          <div className="px-6 py-16 text-center space-y-3">
            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Список пока пуст
            </p>
            <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Откройте любое приложение из каталога или по App ID, чтобы получить прямую ссылку на скачивание с серверов Apple.
            </p>
            <button
              type="button"
              onClick={() => onOpenExtractor('', '')}
              className="min-h-[44px] px-5 py-2.5 text-sm font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] text-white transition-colors cursor-pointer"
            >
              Открыть загрузчик по ID
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {records.map((rec) => {
              const manifestToken = new URLSearchParams(rec.manifestPath.split('?')[1] || '').get('token') || '';
              const showQr = expandedQrId === rec.id;

              return (
                <li key={rec.id} className="p-4 sm:p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <AppIcon
                        src={rec.iconURL}
                        name={rec.appName}
                        seed={rec.appID}
                        size="md"
                      />
                      <div className="min-w-0 space-y-1">
                        <button
                          type="button"
                          onClick={() => onOpenExtractor(rec.appID, rec.externalVersionID)}
                          className="font-semibold text-sm sm:text-[15px] text-slate-900 dark:text-slate-100 hover:text-[#0066FF] dark:hover:text-blue-400 truncate block text-left cursor-pointer"
                        >
                          {rec.appName}
                        </button>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          <span>v{rec.version}</span>
                          <span aria-hidden="true">·</span>
                          <span>Ext {rec.externalVersionID}</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatBytes(rec.fileSizeBytes)}</span>
                          {rec.minOSVersion && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>iOS {rec.minOSVersion}+</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = buildItmsServicesUrl(rec.manifestPath);
                        }}
                        className="min-h-[42px] px-3.5 py-2 text-xs font-semibold rounded-xl bg-[#0066FF] hover:bg-[#0052CC] text-white transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <Smartphone className="w-3.5 h-3.5" />
                        <span>Установить</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          triggerDirectFileDownload(
                            rec.directCdnUrl,
                            `${rec.bundleID}-${rec.version}.ipa`
                          )
                        }
                        className="min-h-[42px] px-3.5 py-2 text-xs font-medium rounded-xl border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Скачать IPA</span>
                      </button>

                      {manifestToken && (
                        <button
                          type="button"
                          aria-label="Показать QR-код для iPhone"
                          onClick={() => setExpandedQrId(showQr ? null : rec.id)}
                          className="min-h-[42px] min-w-[42px] px-2.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center cursor-pointer"
                        >
                          <QrCode className="w-4 h-4" />
                        </button>
                      )}

                      {rec.metadataPlistXml && (
                        <button
                          type="button"
                          aria-label="Скачать iTunesMetadata.plist"
                          onClick={() =>
                            downloadTextFile(
                              `iTunesMetadata-${rec.appID}.plist`,
                              rec.metadataPlistXml || ''
                            )
                          }
                          className="min-h-[42px] min-w-[42px] px-2.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center cursor-pointer"
                        >
                          <FileCode2 className="w-4 h-4" />
                        </button>
                      )}

                      <button
                        type="button"
                        aria-label="Удалить из истории"
                        onClick={() => onDelete(rec.id)}
                        className="min-h-[42px] min-w-[42px] px-2.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-200 dark:hover:border-rose-900/60 transition-colors inline-flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {showQr && manifestToken && (
                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800/80 flex justify-center">
                      <QrCodeBox
                        value={buildQrHandoffUrl(manifestToken, rec.appName)}
                        caption="Отсканируйте камерой iPhone для прямой установки"
                        size={156}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
