import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderShareCardToBlob, type ShareCardData } from './shareCardRenderer'

export function useShareCardImage() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const blobRef = useRef<Blob | null>(null)
  const urlRef = useRef<string | null>(null)
  const generationIdRef = useRef(0)

  const revokeCurrentPreviewUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const clearCurrentPreview = useCallback(() => {
    blobRef.current = null
    revokeCurrentPreviewUrl()
    setPreviewUrl(null)
  }, [revokeCurrentPreviewUrl])

  const supportsNativeFileShare = useCallback((files: File[]) => {
    if (typeof navigator === 'undefined') return false
    if (typeof navigator.share !== 'function') return false
    if (typeof navigator.canShare !== 'function') return false
    try {
      return navigator.canShare({ files })
    } catch {
      return false
    }
  }, [])

  // Clean up object URL on unmount
  useEffect(() => {
    return () => {
      generationIdRef.current += 1
      revokeCurrentPreviewUrl()
    }
  }, [revokeCurrentPreviewUrl])

  const generatePreview = useCallback(async (data: ShareCardData) => {
    const generationId = generationIdRef.current + 1
    generationIdRef.current = generationId
    setIsGenerating(true)
    clearCurrentPreview()

    try {
      const blob = await renderShareCardToBlob(data)
      if (generationId !== generationIdRef.current) return

      blobRef.current = blob

      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setPreviewUrl(url)
    } catch (err) {
      if (generationId !== generationIdRef.current) return
      console.error('Failed to generate share card:', err)
    } finally {
      if (generationId === generationIdRef.current) {
        setIsGenerating(false)
      }
    }
  }, [clearCurrentPreview])

  const downloadImage = useCallback(() => {
    if (!blobRef.current) return

    const url = URL.createObjectURL(blobRef.current)
    const a = document.createElement('a')
    a.href = url
    a.download = 'sol-squeeze-share.png'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [])

  const nativeShare = useCallback(async (caption: string) => {
    if (!blobRef.current) return false

    const file = new File([blobRef.current], 'sol-squeeze-share.png', {
      type: 'image/png',
    })

    if (!supportsNativeFileShare([file])) return false

    const shareDataWithText: ShareData = { files: [file], text: caption }
    const shareData = navigator.canShare(shareDataWithText)
      ? shareDataWithText
      : ({ files: [file] } as ShareData)

    try {
      await navigator.share(shareData)
      return true
    } catch (err) {
      // User cancelled or share failed
      if (err instanceof Error && err.name !== 'AbortError') {
        console.error('Share failed:', err)
      }
      return false
    }
  }, [supportsNativeFileShare])

  const copyImageToClipboard = useCallback(async () => {
    if (!blobRef.current) return false
    if (typeof navigator === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
      return false
    }
    if (typeof ClipboardItem !== 'function') return false

    try {
      const clipboardItemData: Record<string, Blob> = {
        'image/png': blobRef.current,
      }
      await navigator.clipboard.write([new ClipboardItem(clipboardItemData)])
      return true
    } catch (err) {
      if (err instanceof Error) {
        console.error('Clipboard image copy failed:', err)
      }
      return false
    }
  }, [])

  const canNativeShare = useMemo(() => {
    if (typeof File !== 'function') return false
    try {
      return supportsNativeFileShare([
        new File([new Uint8Array(1)], 'sol-squeeze-share-check.png', { type: 'image/png' }),
      ])
    } catch {
      return false
    }
  }, [supportsNativeFileShare])

  return {
    previewUrl,
    isGenerating,
    generatePreview,
    downloadImage,
    nativeShare,
    copyImageToClipboard,
    canNativeShare,
  }
}
