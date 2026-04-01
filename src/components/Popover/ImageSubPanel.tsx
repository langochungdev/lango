import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageOption } from '@/services/images'
import { searchImages } from '@/services/images'
import { SubPanel } from '@/components/Popover/SubPanel'

interface ImageSubPanelProps {
  popoverRef: React.RefObject<HTMLElement | null>
  visible: boolean
  imageQuery: string
}

const IMAGE_PAGE_SIZE = 12

export function ImageSubPanel({ popoverRef, visible, imageQuery }: ImageSubPanelProps) {
  const [imageLoading, setImageLoading] = useState(false)
  const [imageLoadingMore, setImageLoadingMore] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [imageItems, setImageItems] = useState<ImageOption[]>([])
  const [imageHasMore, setImageHasMore] = useState(false)
  const [imageNextPage, setImageNextPage] = useState<number | null>(null)
  const imageRequestIdRef = useRef(0)
  const imageLoadMoreRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    imageRequestIdRef.current += 1
    setImageLoading(false)
    setImageLoadingMore(false)
    setImageError(null)
    setImageItems([])
    setImageHasMore(false)
    setImageNextPage(null)
  }, [imageQuery, visible])

  useEffect(() => {
    if (!visible || !imageQuery) return
    const requestId = ++imageRequestIdRef.current
    setImageLoading(true)
    setImageLoadingMore(false)
    setImageError(null)
    setImageHasMore(false)
    setImageNextPage(null)

    void (async () => {
      try {
        const result = await searchImages({ query: imageQuery, page: 1, page_size: IMAGE_PAGE_SIZE })
        if (imageRequestIdRef.current !== requestId) return
        setImageItems(Array.isArray(result.options) ? result.options : [])
        setImageHasMore(Boolean(result.has_more))
        setImageNextPage(result.next_page ?? null)
        setImageError(result.error?.trim() ? result.error : null)
      } catch {
        if (imageRequestIdRef.current !== requestId) return
        setImageItems([])
        setImageHasMore(false)
        setImageNextPage(null)
        setImageError('Image search failed')
      } finally {
        if (imageRequestIdRef.current === requestId) setImageLoading(false)
      }
    })()
  }, [imageQuery, visible])

  const loadMoreImages = useCallback(async () => {
    if (!visible || !imageQuery || imageLoading || imageLoadingMore) {
      return
    }
    if (!imageHasMore || !imageNextPage) {
      return
    }

    const requestId = imageRequestIdRef.current
    setImageLoadingMore(true)

    try {
      const result = await searchImages({ query: imageQuery, page: imageNextPage, page_size: IMAGE_PAGE_SIZE })
      if (imageRequestIdRef.current !== requestId) {
        return
      }

      const incoming = Array.isArray(result.options) ? result.options : []
      setImageItems((current) => {
        const seen = new Set(current.map((item) => `${item.src}|${item.page_url}`))
        const next = [...current]
        for (const item of incoming) {
          const key = `${item.src}|${item.page_url}`
          if (!seen.has(key)) {
            seen.add(key)
            next.push(item)
          }
        }
        return next
      })
      setImageHasMore(Boolean(result.has_more))
      setImageNextPage(result.next_page ?? null)
      if (result.error?.trim()) {
        setImageError(result.error)
      }
    } catch {
      if (imageRequestIdRef.current !== requestId) {
        return
      }
      setImageError('Image load more failed')
    } finally {
      if (imageRequestIdRef.current === requestId) {
        setImageLoadingMore(false)
      }
    }
  }, [imageHasMore, imageLoading, imageLoadingMore, imageNextPage, imageQuery, visible])

  useEffect(() => {
    if (!visible) {
      return
    }

    const marker = imageLoadMoreRef.current
    if (!marker) {
      return
    }

    const root = marker.closest('.apl-subpanel')
    if (!(root instanceof HTMLElement)) {
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries.find((entry) => entry.isIntersecting)
        if (visibleEntry) {
          void loadMoreImages()
        }
      },
      {
        root,
        rootMargin: '120px 0px',
        threshold: 0.01,
      },
    )

    observer.observe(marker)
    return () => {
      observer.disconnect()
    }
  }, [loadMoreImages, visible])

  return (
    <SubPanel
      popoverRef={popoverRef}
      visible={visible}
      panelMode="images"
    >
      <div className="apl-subpanel-body apl-image-grid">
        {!imageLoading && imageItems.length > 0 && imageItems.map((item, i) => (
          <a key={`${item.src}-${i}`} className="apl-image-card" href={item.page_url || item.src} target="_blank" rel="noopener noreferrer">
            <img src={item.src} alt={item.title || `${imageQuery} ${i + 1}`} loading={i < 4 ? 'eager' : 'lazy'} />
          </a>
        ))}
        {imageLoadingMore && <p className="apl-meta">Loading more images...</p>}
        {visible && imageHasMore && <div ref={imageLoadMoreRef} className="apl-image-loadmore-marker" aria-hidden="true" />}
        {!imageLoading && imageItems.length === 0 && <p className="apl-meta">{imageError || 'No image results.'}</p>}
      </div>
    </SubPanel>
  )
}
