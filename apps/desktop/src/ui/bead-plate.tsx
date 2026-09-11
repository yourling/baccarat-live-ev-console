import type { DesktopBeadHand } from '../api-types';

const BEAD_RESULT_LABEL: Record<DesktopBeadHand['result'], string> = {
  banker: '庄',
  player: '闲',
  tie: '和',
};

function beadTitle(bead: DesktopBeadHand): string {
  const marks: string[] = [];
  if (bead.bankerPair) marks.push('庄对');
  if (bead.playerPair) marks.push('闲对');
  return `#${bead.handId} ${BEAD_RESULT_LABEL[bead.result]}${marks.length > 0 ? ` · ${marks.join('+')}` : ''}`;
}

/** 珠盘路子：按列填充（先竖后横，标准珠盘惯例），底色=庄/闲/和，角标=对子。 */
export function BeadPlate(props: {
  beads: readonly DesktopBeadHand[];
  rows?: number;
  columns?: number;
  compact?: boolean;
  ariaLabel?: string;
}) {
  const rows = props.rows ?? 6;
  const columns = props.columns ?? 13;
  const capacity = rows * columns;
  const shown = props.beads.slice(-capacity);
  const cells: Array<DesktopBeadHand | undefined> = Array.from(
    { length: capacity },
    (_, index) => shown[index],
  );
  return (
    <div
      className={props.compact ? 'bead-plate bead-plate--compact' : 'bead-plate'}
      role="img"
      aria-label={props.ariaLabel ?? `珠盘路子，共 ${props.beads.length} 局`}
      style={{
        gridTemplateRows: `repeat(${rows}, var(--bead-size))`,
        gridTemplateColumns: `repeat(${columns}, var(--bead-size))`,
      }}
    >
      {cells.map((bead, index) =>
        bead === undefined ? (
          <span key={index} className="bead bead--empty" />
        ) : (
          <span key={index} className={`bead bead--${bead.result}`} title={beadTitle(bead)}>
            <span className="bead__label">{BEAD_RESULT_LABEL[bead.result]}</span>
            {bead.bankerPair && <i className="bead__mark bead__mark--banker" />}
            {bead.playerPair && <i className="bead__mark bead__mark--player" />}
          </span>
        ),
      )}
    </div>
  );
}

export function BeadLegend() {
  return (
    <div className="bead-legend" aria-label="珠盘图例">
      <span className="bead-legend__item"><i className="bead bead--banker" />庄</span>
      <span className="bead-legend__item"><i className="bead bead--player" />闲</span>
      <span className="bead-legend__item"><i className="bead bead--tie" />和</span>
      <span className="bead-legend__item">
        <i className="bead bead--banker"><i className="bead__mark bead__mark--banker" /></i>庄对（左上红点）
      </span>
      <span className="bead-legend__item">
        <i className="bead bead--player"><i className="bead__mark bead__mark--player" /></i>闲对（右上蓝点）
      </span>
      <span className="bead-legend__item">
        <i className="bead bead--banker">
          <i className="bead__mark bead__mark--banker" />
          <i className="bead__mark bead__mark--player" />
        </i>
        通对（双点）
      </span>
    </div>
  );
}
