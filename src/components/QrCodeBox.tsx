import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

interface QrCodeBoxProps {
  value: string;
  caption?: string;
  size?: number;
}

export function QrCodeBox({ value, caption, size = 168 }: QrCodeBoxProps) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, {
      width: size * 2,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0F172A',
        light: '#FFFFFF',
      },
    })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => {
        if (active) setDataUrl('');
      });

    return () => {
      active = false;
    };
  }, [value, size]);

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse"
      />
    );
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="p-2.5 bg-white rounded-xl border border-slate-200 dark:border-slate-700">
        <img
          src={dataUrl}
          alt={caption || 'QR-код для установки на iPhone'}
          width={size}
          height={size}
          className="block rounded-lg"
        />
      </div>
      {caption && (
        <p className="text-xs text-slate-500 dark:text-slate-400 text-center max-w-[240px]">
          {caption}
        </p>
      )}
    </div>
  );
}
