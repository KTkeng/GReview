import { useEffect, useState } from 'react';
import type { GameMeta, GamePresentation } from '../types';
import { gameTitleInfo } from '../lib/gameTitle';

/** 「自定义」徽标：12px / #38BDF8 / #1F2937 背景 / 4px 圆角。 */
export function CustomTitleBadge() {
  return <span className="custom-title-badge">自定义</span>;
}

interface GameCoverProps {
  game: GameMeta | GamePresentation | string | null | undefined;
  appid?: number | null;
  width: number;
  height: number;
  className?: string;
}

/**
 * 封面：加载失败或缺失时渲染后端 coverPlaceholder（如「AppID 570」），
 * 不拼接路径、不改变标题逻辑。
 */
export function GameCover({ game, appid, width, height, className }: GameCoverProps) {
  const info = gameTitleInfo(game, appid);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [info.coverUrl]);

  const sizeStyle = { width, height };

  if (!info.coverUrl || failed) {
    return (
      <span
        className={`cover-placeholder${className ? ` ${className}` : ''}`}
        style={sizeStyle}
        role="img"
        aria-label={info.coverPlaceholder}
      >
        {info.coverPlaceholder}
      </span>
    );
  }

  return (
    <img
      className={`cover-image${className ? ` ${className}` : ''}`}
      src={info.coverUrl}
      alt={`${info.displayTitle} 封面`}
      width={width}
      height={height}
      loading="lazy"
      referrerPolicy="no-referrer"
      style={sizeStyle}
      onError={() => setFailed(true)}
    />
  );
}

export function CoverThumb(props: Omit<GameCoverProps, 'width' | 'height'>) {
  return <GameCover {...props} width={32} height={32} className="cover-thumb" />;
}

export function ReportCover(props: Omit<GameCoverProps, 'width' | 'height'>) {
  return <GameCover {...props} width={120} height={56} className="report-cover" />;
}
