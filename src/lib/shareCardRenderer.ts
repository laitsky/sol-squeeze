export interface ShareCardData {
  reclaimedLabel: string
  soldCount: number
}

const W = 1080
const H = 1440
const PAD = 72

const BG = '#1C1C1C'
const ORANGE = 'rgb(240, 120, 0)'
const ORANGE_BORDER = 'rgba(240, 120, 0, 0.35)'
const FG = '#EDEDED'
const FG_DIM = 'rgba(237, 237, 237, 0.75)'
const FG_MUTED = 'rgba(237, 237, 237, 0.5)'

const FONT_SERIF = "'Instrument Serif', Georgia, serif"
const FONT_MONO = "'Azeret Mono', ui-monospace, monospace"

export async function renderShareCardToBlob(
  data: ShareCardData,
): Promise<Blob> {
  // Wait for Google Fonts to be available
  await document.fonts.ready

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // -- Background
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)

  // -- Decorative glows
  // Orange glow (top-right)
  const orangeGlow = ctx.createRadialGradient(W * 0.92, H * 0.05, 0, W * 0.92, H * 0.05, W * 0.72)
  orangeGlow.addColorStop(0, 'rgba(240, 120, 0, 0.18)')
  orangeGlow.addColorStop(1, 'rgba(240, 120, 0, 0)')
  ctx.fillStyle = orangeGlow
  ctx.fillRect(0, 0, W, H)

  // White glow (bottom-left)
  const whiteGlow = ctx.createRadialGradient(-W * 0.08, H * 1.02, 0, -W * 0.08, H * 1.02, W * 0.52)
  whiteGlow.addColorStop(0, 'rgba(237, 237, 237, 0.08)')
  whiteGlow.addColorStop(1, 'rgba(237, 237, 237, 0)')
  ctx.fillStyle = whiteGlow
  ctx.fillRect(0, 0, W, H)

  // -- Border (1px orange)
  ctx.strokeStyle = ORANGE_BORDER
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, W - 2, H - 2)

  // -- Left accent line
  ctx.fillStyle = ORANGE
  ctx.fillRect(0, 0, 4, H)

  // -- Top utility labels
  ctx.textBaseline = 'top'
  ctx.fillStyle = FG_MUTED
  ctx.font = `500 17px ${FONT_MONO}`
  ctx.fillText('SHARE YOUR WIN', PAD, 52)

  // -- Branding: "Sol Squeeze" top-left
  ctx.font = `italic 56px ${FONT_SERIF}`
  ctx.fillStyle = FG_DIM
  ctx.fillText('Sol Squeeze', PAD, 132)

  // -- Hero text: reclaimed SOL amount
  const heroSize = fitHeroText(ctx, data.reclaimedLabel, W - PAD * 2, 138, 66)
  ctx.font = `italic ${heroSize}px ${FONT_SERIF}`
  ctx.fillStyle = FG
  ctx.textBaseline = 'alphabetic'
  const heroY = 470
  ctx.fillText(data.reclaimedLabel, PAD, heroY)

  // -- Subtext: "reclaimed from X dust tokens"
  const tokenWord = data.soldCount === 1 ? 'dust token' : 'dust tokens'
  const subtext = `reclaimed from ${data.soldCount.toLocaleString()} ${tokenWord}`
  ctx.font = `400 31px ${FONT_MONO}`
  ctx.fillStyle = FG_DIM
  ctx.fillText(subtext, PAD, heroY + 52)

  // -- Decorative separator
  ctx.fillStyle = ORANGE_BORDER
  ctx.fillRect(PAD, heroY + 110, 170, 2)

  // -- Caption line
  const caption = `I just reclaimed ${data.reclaimedLabel} from ${data.soldCount.toLocaleString()} ${tokenWord} with Sol Squeeze.`
  ctx.font = `400 25px ${FONT_MONO}`
  ctx.fillStyle = FG_MUTED
  wrapText(ctx, caption, PAD, heroY + 170, W - PAD * 2, 38)

  // -- Bottom branding
  ctx.font = `400 24px ${FONT_MONO}`
  ctx.fillStyle = FG_MUTED
  ctx.textBaseline = 'bottom'
  const siteLabel = 'solsqueeze.app'
  const siteLabelWidth = ctx.measureText(siteLabel).width
  ctx.fillText(siteLabel, W - PAD - siteLabelWidth, H - PAD)

  // -- Small orange dot next to site label
  ctx.fillStyle = ORANGE
  ctx.beginPath()
  ctx.arc(W - PAD - siteLabelWidth - 20, H - PAD - 8, 4.5, 0, Math.PI * 2)
  ctx.fill()

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Canvas toBlob returned null'))
      },
      'image/png',
    )
  })
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(' ')
  let line = ''
  let currentY = y

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word
    const metrics = ctx.measureText(testLine)
    if (metrics.width > maxWidth && line) {
      ctx.fillText(line, x, currentY)
      line = word
      currentY += lineHeight
    } else {
      line = testLine
    }
  }
  if (line) {
    ctx.fillText(line, x, currentY)
  }
}

function fitHeroText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  initialSize: number,
  minSize: number,
): number {
  let size = initialSize
  while (size > minSize) {
    ctx.font = `italic ${size}px ${FONT_SERIF}`
    if (ctx.measureText(text).width <= maxWidth) {
      return size
    }
    size -= 2
  }
  return minSize
}
