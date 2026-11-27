import { useState } from 'react';
import { getAppMonogram, getDeterministicTint } from '../shared/parsers.ts';

interface AppIconProps {
  src?: string;
  name: string;
  seed: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES = {
  sm: 'w-10 h-10 text-xs rounded-[10px]',
  md: 'w-12 h-12 text-sm rounded-[12px]',
  lg: 'w-16 h-16 text-lg rounded-[16px]',
};

export function AppIcon({ src, name, seed, size = 'md' }: AppIconProps) {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${SIZE_CLASSES[size]} shrink-0 object-cover border border-slate-200/80 dark:border-slate-700/70 bg-slate-100 dark:bg-slate-800`}
      />
    );
  }

  const bg = getDeterministicTint(seed || name);
  const monogram = getAppMonogram(name);

  return (
    <div
      aria-hidden="true"
      style={{ backgroundColor: bg }}
      className={`${SIZE_CLASSES[size]} shrink-0 flex items-center justify-center font-display font-bold text-white tracking-tight select-none`}
    >
      {monogram}
    </div>
  );
}
