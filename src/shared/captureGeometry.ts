export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Decide which part of a full-display screenshot should be sent to OCR.
 * The sidebar is not part of the reading surface, so cut it away when it
 * overlaps the display. Coordinates returned are in screenshot pixels.
 */
export function computeContextCrop(
  displayBounds: Rect,
  workArea: Rect,
  imageSize: Size,
  mainBounds: Rect | null,
  side: 'right' | 'top'
): Rect {
  const scaleX = imageSize.width / displayBounds.width
  const scaleY = imageSize.height / displayBounds.height
  let x = Math.max(0, Math.round((workArea.x - displayBounds.x) * scaleX))
  let y = Math.max(0, Math.round((workArea.y - displayBounds.y) * scaleY))
  let width = Math.min(imageSize.width - x, Math.round(workArea.width * scaleX))
  let height = Math.min(imageSize.height - y, Math.round(workArea.height * scaleY))

  if (mainBounds) {
    const overlapX =
      Math.min(mainBounds.x + mainBounds.width, displayBounds.x + displayBounds.width) -
      Math.max(mainBounds.x, displayBounds.x)
    const overlapY =
      Math.min(mainBounds.y + mainBounds.height, displayBounds.y + displayBounds.height) -
      Math.max(mainBounds.y, displayBounds.y)
    if (overlapX > 0 && overlapY > 0) {
      if (side === 'right' && mainBounds.x > displayBounds.x + workArea.width * 0.45) {
        const cut = Math.round((mainBounds.x - displayBounds.x - 4) * scaleX)
        width = Math.min(width, Math.max(0, cut - x))
      } else if (side === 'top' && mainBounds.y < displayBounds.y + workArea.height * 0.5) {
        const top = Math.round((mainBounds.y + mainBounds.height + 4 - displayBounds.y) * scaleY)
        const nextY = Math.max(y, top)
        height = Math.max(0, height - (nextY - y))
        y = nextY
      }
    }
  }

  if (width < 120 || height < 80) {
    return { x: 0, y: 0, width: imageSize.width, height: imageSize.height }
  }
  return { x, y, width, height }
}
