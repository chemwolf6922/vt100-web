import type { TerminalCell, TerminalLine, TerminalSnapshot } from './vt100.js';

export interface CursorAppearance {
  style: 'block' | 'underline';
  blink: boolean;
}

export default class TerminalView {
  private readonly rows: HTMLDivElement[] = [];
  private previousLines: readonly TerminalLine[] = [];
  private revisions: number[] = [];
  private cursor = { row: -1, col: -1 };
  private columns = 0;
  private animation: Animation | null = null;

  constructor(
    private readonly screen: HTMLElement,
    private readonly terminal: HTMLElement,
  ) {}

  render(snapshot: TerminalSnapshot, appearance: CursorAppearance): void {
    this.terminal.classList.toggle('cursor-block', appearance.style === 'block');
    this.terminal.classList.toggle('cursor-underline', appearance.style === 'underline');
    this.terminal.classList.toggle('cursor-blink', appearance.blink);
    this.screen.classList.toggle('reverse-video', snapshot.modes.reverseVideo);
    this.screen.style.setProperty('--columns', String(snapshot.columns));
    this.terminal.dataset.cursorRow = String(snapshot.cursor.row + 1);
    this.terminal.dataset.cursorColumn = String(snapshot.cursor.col + 1);

    const scroll = this.findScroll(snapshot);
    const oldRows = scroll
      ? this.rows.slice(scroll.top, scroll.bottom + 1).map((row) => row.cloneNode(true))
      : [];
    while (this.rows.length < snapshot.lines.length) {
      const row = document.createElement('div');
      row.className = 'terminal-row';
      row.dataset.row = String(this.rows.length + 1);
      const line = document.createElement('div');
      line.className = 'terminal-line';
      row.append(line);
      this.rows.push(row);
      this.screen.append(row);
    }
    snapshot.lines.forEach((line, index) => {
      if (
        this.columns !== snapshot.columns ||
        this.previousLines[index] !== line ||
        this.revisions[index] !== line.revision ||
        index === this.cursor.row ||
        index === snapshot.cursor.row
      ) this.renderLine(this.rows[index], line, snapshot, index);
    });

    if (scroll) this.animateScroll(scroll, oldRows);
    this.previousLines = [...snapshot.lines];
    this.revisions = snapshot.lines.map((line) => line.revision);
    this.cursor = { ...snapshot.cursor };
    this.columns = snapshot.columns;
  }

  bell(): void {
    this.terminal.classList.remove('bell-flash');
    void this.terminal.offsetWidth;
    this.terminal.classList.add('bell-flash');
  }

  dispose(): void {
    this.animation?.cancel();
  }

  private renderLine(
    row: HTMLDivElement,
    line: TerminalLine,
    snapshot: TerminalSnapshot,
    rowIndex: number,
  ): void {
    row.dataset.size = line.size;
    const content = row.firstElementChild;
    if (!(content instanceof HTMLElement)) {
      throw new Error('The terminal row has no content element.');
    }
    const limit = line.size === 'normal' ? snapshot.columns : snapshot.columns / 2;
    const fragment = document.createDocumentFragment();
    let currentClass = '';
    let text = '';
    const appendRun = () => {
      if (!text) return;
      if (currentClass) {
        const span = document.createElement('span');
        span.className = currentClass;
        span.textContent = text;
        fragment.append(span);
      } else {
        fragment.append(document.createTextNode(text));
      }
    };
    for (let column = 0; column < limit; column++) {
      const cell = line.cells[column];
      if (!cell) {
        throw new Error(`Missing terminal cell at row ${rowIndex + 1}, column ${column + 1}.`);
      }
      const cursor = snapshot.cursor.row === rowIndex && snapshot.cursor.col === column;
      const className = this.cellClass(cell, cursor);
      if (className !== currentClass) {
        appendRun();
        text = '';
        currentClass = className;
      }
      text += cell.text;
    }
    appendRun();
    content.replaceChildren(fragment);
  }

  private cellClass(cell: TerminalCell, cursor: boolean): string {
    return [
      cell.bold ? 'cell-bold' : '',
      cell.underline ? 'cell-underline' : '',
      cell.blink ? 'cell-blink' : '',
      cell.inverse ? 'cell-inverse' : '',
      cursor ? 'cursor-cell' : '',
    ].filter(Boolean).join(' ');
  }

  private findScroll(snapshot: TerminalSnapshot): { top: number; bottom: number; delta: number } | null {
    if (
      !snapshot.modes.smoothScroll ||
      this.columns !== snapshot.columns ||
      this.previousLines.length !== snapshot.lines.length ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return null;
    const changed = snapshot.lines
      .map((line, index) => line === this.previousLines[index] ? -1 : index)
      .filter((index) => index >= 0);
    if (changed.length < 2) return null;
    const top = changed[0];
    const bottom = changed[changed.length - 1];
    let delta = 0;
    for (let index = top; index <= bottom; index++) {
      const oldIndex = this.previousLines.indexOf(snapshot.lines[index]);
      if (oldIndex < top || oldIndex > bottom) continue;
      const movement = oldIndex - index;
      if (!movement || (delta && movement !== delta)) return null;
      delta = movement;
    }
    return delta ? { top, bottom, delta } : null;
  }

  private animateScroll(
    { top, bottom, delta }: { top: number; bottom: number; delta: number },
    oldRows: Node[],
  ): void {
    this.animation?.cancel();
    const height = this.rows[top].getBoundingClientRect().height;
    const overlay = document.createElement('div');
    overlay.className = 'scroll-animation';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.top = `${top * height}px`;
    overlay.style.height = `${(bottom - top + 1) * height}px`;
    const content = document.createElement('div');
    if (delta > 0) {
      content.append(...oldRows, ...this.rows.slice(bottom - delta + 1, bottom + 1).map((row) => row.cloneNode(true)));
    } else {
      content.append(...this.rows.slice(top, top - delta).map((row) => row.cloneNode(true)), ...oldRows);
    }
    overlay.append(content);
    this.screen.append(overlay);
    const offset = Math.abs(delta) * height;
    const animation = content.animate(
      [
        { transform: `translateY(${delta > 0 ? 0 : -offset}px)` },
        { transform: `translateY(${delta > 0 ? -offset : 0}px)` },
      ],
      { duration: Math.min(Math.abs(delta) * (1000 / 6), 1000), easing: 'linear' },
    );
    this.animation = animation;
    const finish = () => {
      overlay.remove();
      if (this.animation === animation) this.animation = null;
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }
}
