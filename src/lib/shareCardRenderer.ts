export interface ShareCardData {
  reclaimedLabel: string
  soldCount: number
}

const W = 1200
const H = 630
const PAD = 78

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
  const orangeGlow = ctx.createRadialGradient(W * 0.88, H * 0.08, 0, W * 0.88, H * 0.08, W * 0.42)
  orangeGlow.addColorStop(0, 'rgba(240, 120, 0, 0.18)')
  orangeGlow.addColorStop(1, 'rgba(240, 120, 0, 0)')
  ctx.fillStyle = orangeGlow
  ctx.fillRect(0, 0, W, H)

  const whiteGlow = ctx.createRadialGradient(-W * 0.04, H * 1.04, 0, -W * 0.04, H * 1.04, W * 0.28)
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

  ctx.textBaseline = 'top'

  // -- Branding block
  const logoBoxSize = 118
  const logoY = 138
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)'
  ctx.fillRect(PAD, logoY, logoBoxSize, logoBoxSize)
  ctx.strokeStyle = ORANGE_BORDER
  ctx.lineWidth = 2
  ctx.strokeRect(PAD, logoY, logoBoxSize, logoBoxSize)

  ctx.fillStyle = FG
  ctx.font = `italic 78px ${FONT_SERIF}`
  ctx.fillText('SS', PAD + 24, logoY + 28)

  ctx.font = `italic 56px ${FONT_SERIF}`
  ctx.fillStyle = FG_DIM
  ctx.fillText('Sol Squeeze', PAD + logoBoxSize + 26, 166)

  // -- Kicker
  ctx.fillStyle = ORANGE
  ctx.font = `500 22px ${FONT_MONO}`
  drawTrackingText(ctx, 'SELL + BURN', PAD, 300, 5)

  // -- Hero text: reclaimed SOL amount
  const heroY = 340
  const heroSize = fitText(ctx, data.reclaimedLabel, W - PAD * 2, 102, 60)
  ctx.font = `italic ${heroSize}px ${FONT_SERIF}`
  ctx.fillStyle = FG
  ctx.fillText(data.reclaimedLabel, PAD, heroY)

  // -- Supporting line
  const secondaryLine = 'reclaimed to SOL'
  const secondarySize = fitText(ctx, secondaryLine, W - PAD * 2, 84, 48)
  ctx.font = `italic ${secondarySize}px ${FONT_SERIF}`
  ctx.fillStyle = FG
  ctx.fillText(secondaryLine, PAD, heroY + heroSize * 0.98)

  // -- Subtext
  const tokenWord = data.soldCount === 1 ? 'dust token' : 'dust tokens'
  const subtext = `from ${data.soldCount.toLocaleString()} ${tokenWord}`
  ctx.font = `400 22px ${FONT_MONO}`
  ctx.fillStyle = FG_DIM
  ctx.fillText(subtext, PAD, 536)

  // -- Decorative separator
  ctx.fillStyle = ORANGE_BORDER
  ctx.fillRect(PAD, 586, 180, 2)

  // -- Bottom branding
  ctx.font = `400 18px ${FONT_MONO}`
  ctx.fillStyle = FG_MUTED
  const siteLabel = 'solsqueeze.app'
  const siteLabelWidth = ctx.measureText(siteLabel).width
  ctx.fillText(siteLabel, W - PAD - siteLabelWidth, H - 70)

  // -- Small orange dot next to site label
  ctx.fillStyle = ORANGE
  ctx.beginPath()
  ctx.arc(W - PAD - siteLabelWidth - 18, H - 60, 5, 0, Math.PI * 2)
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

function drawTrackingText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  tracking: number,
) {
  let currentX = x
  for (const char of text) {
    ctx.fillText(char, currentX, y)
    currentX += ctx.measureText(char).width + tracking
  }
}

function fitText(
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
