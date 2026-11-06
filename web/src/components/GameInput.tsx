import { useState, type FormEvent } from 'react';
import type { GameMeta } from '../types';
import { IconSearch } from './Icon';
import { FieldError } from './ui';

interface GameInputProps {
  value: string;
  onChange: (value: string) => void;
  onResolve: () => void;
  resolving: boolean;
  game: GameMeta | null;
  appid: number | null;
  error: string | null;
}

const EXAMPLE_INPUT = 'https://store.steampowered.com/app/570/Dota_2/';

export function GameInput({
  value,
  onChange,
  onResolve,
  resolving,
  game,
  appid,
  error,
}: GameInputProps) {
  const [showExample, setShowExample] = useState(true);
  const headerImage =
    (game?.headerImage as string | undefined) ??
    (game?.header_image as string | undefined) ??
    null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onResolve();
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="game-input">Steam 游戏链接或 AppID</label>
        <div className="input-row">
          <input
            id="game-input"
            className="input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="粘贴商店链接或输入 AppID，如 570"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'game-input-error' : 'game-input-hint'}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className="btn" disabled={resolving || !value.trim()}>
            {resolving ? <span className="spinner" aria-hidden="true" /> : <IconSearch size={15} />}
            <span>{resolving ? '解析中' : '解析'}</span>
          </button>
        </div>
        {error ? (
          <div id="game-input-error">
            <FieldError>{error}</FieldError>
          </div>
        ) : (
          <p id="game-input-hint" className="field-hint">
            支持商店链接、社区链接或纯 AppID 数字。
            {showExample ? (
              <>
                {' '}
                示例：
                <button
                  type="button"
                  className="example-link"
                  onClick={() => {
                    onChange(EXAMPLE_INPUT);
                    setShowExample(false);
                  }}
                >
                  {EXAMPLE_INPUT}
                </button>
              </>
            ) : null}
          </p>
        )}
        {game && appid ? (
          <div className="game-resolve-status" aria-live="polite">
            {headerImage ? (
              <img src={headerImage} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ) : null}
            <div style={{ minWidth: 0 }}>
              <div className="name" title={game.name}>
                {game.name}
              </div>
              <div className="appid mono-num">AppID {appid}</div>
            </div>
            <span className="badge badge-positive" style={{ marginLeft: 'auto' }}>
              已解析
            </span>
          </div>
        ) : null}
      </div>
    </form>
  );
}
