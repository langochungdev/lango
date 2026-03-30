export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SelectionAnchor {
  point?: ScreenPoint | null;
  rect?: ScreenRect | null;
}
