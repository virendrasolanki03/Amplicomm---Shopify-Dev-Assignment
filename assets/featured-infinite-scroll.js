/*
 * <featured-infinite-scroll>
 *
 * Wraps the collection product grid. Lives INSIDE #ProductGridContainer so that
 * Dawn's facets.js (which replaces the container's innerHTML on every sort/filter)
 * destroys and recreates this element, re-running connectedCallback automatically.
 *
 * Responsibilities:
 *   - Pin featured products at the top (rendered server-side; this element only
 *     reads their ids so they are never loaded again below).
 *   - Infinite scroll the remaining products in batches via the Section Rendering API.
 *   - Guarantee no product is ever rendered twice (renderedIds Set), which also
 *     handles the case where a later page returns a product already pinned on top.
 *
 * Data attributes (set by the section):
 *   data-section-id  - section id, used for ?section_id= fetches
 *   data-batch-size  - how many NEW products to reveal per scroll batch
 *   data-next-url    - paginate.next.url for the current view ('' when no more pages)
 */
class FeaturedInfiniteScroll extends HTMLElement {
  connectedCallback() {
    if (this.initialized) return;
    this.initialized = true;

    this.grid = this.querySelector('#product-grid');
    if (!this.grid) return;

    this.sectionId = this.dataset.sectionId;
    this.batchSize = parseInt(this.dataset.batchSize, 10) || 20;
    this.nextUrl = this.dataset.nextUrl || '';
    this.loading = false;

    console.log('[FIS] Init - nextUrl:', this.nextUrl, 'batchSize:', this.batchSize, 'pinningMode:', this.dataset.pinningMode);

    // Seed with EVERY product already on the page: pinned featured + the initial
    // normal products. New products are checked against this before rendering.
    this.renderedIds = new Set();
    this.querySelectorAll('[data-product-id]').forEach((el) => {
      this.renderedIds.add(el.dataset.productId);
    });
    console.log('[FIS] Rendered IDs on page:', this.renderedIds.size);

    // Page-1 leftovers (the non-featured products beyond the initial batch) are
    // embedded in a <template> so we don't have to re-fetch page 1.
    this.queue = [];
    const prefetch = this.querySelector('template.fis-prefetch');
    if (prefetch) {
      prefetch.content.querySelectorAll('li[data-product-id]').forEach((li) => {
        this.queue.push(li.cloneNode(true));
      });
    }
    console.log('[FIS] Prefetch queue size:', this.queue.length);

    this.sentinel = this.querySelector('.fis-sentinel');
    this.spinner = this.querySelector('.fis-spinner');
    this.endMessage = this.querySelector('.fis-end');

    console.log('[FIS] Sentinel found:', !!this.sentinel, 'Spinner:', !!this.spinner);

    // Hide the no-JS pagination fallback now that JS has taken over.
    const fallback = this.querySelector('.pagination-wrapper');
    if (fallback) fallback.setAttribute('hidden', '');

    // Add a small delay to ensure DOM is stable before observing
    setTimeout(() => this.observe(), 100);
    
    // Backup: listen to scroll events for manual trigger
    this.scrollListener = () => this.onScroll();
    window.addEventListener('scroll', this.scrollListener, { passive: true });
  }

  disconnectedCallback() {
    if (this.observer) this.observer.disconnect();
    if (this.scrollListener) window.removeEventListener('scroll', this.scrollListener);
  }

  // Show spinner and note timestamp for minimum display duration
  showSpinner() {
    if (!this.spinner) return;
    if (this._spinnerHideTimer) {
      clearTimeout(this._spinnerHideTimer);
      this._spinnerHideTimer = null;
    }
    this.spinner.removeAttribute('hidden');
    this._spinnerShownAt = Date.now();
  }

  // Ensure spinner stays visible at least minDelay ms (default 2000ms)
  hideSpinnerWithMinDelay(minDelay = 2000) {
    if (!this.spinner) return;
    const shownAt = this._spinnerShownAt || 0;
    const elapsed = Date.now() - shownAt;
    const remaining = Math.max(0, minDelay - elapsed);
    if (this._spinnerHideTimer) clearTimeout(this._spinnerHideTimer);
    this._spinnerHideTimer = setTimeout(() => {
      if (this.spinner) this.spinner.setAttribute('hidden', '');
      this._spinnerHideTimer = null;
    }, remaining);
  }

  onScroll() {
    if (!this.sentinel || this.loading) return;
    const rect = this.sentinel.getBoundingClientRect();
    const isNearViewport = rect.top < window.innerHeight + 500 && rect.bottom > -500;
    if (isNearViewport && this.hasMore()) {
      console.log('[FIS] Scroll detected - sentinel near viewport, loading batch');
      this.loadBatch();
    }
  }

  hasMore() {
    return this.queue.length > 0 || this.nextUrl !== '';
  }

  observe() {
    if (!this.sentinel || !this.hasMore()) {
      console.log('[FIS] No more items or no sentinel, finishing');
      this.finish();
      return;
    }
    console.log('[FIS] Setting up observer, has prefetch items:', this.queue.length > 0);
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            console.log('[FIS] Sentinel intersected, loading batch');
            this.loadBatch();
          }
        });
      },
      { rootMargin: '500px' }
    );
    this.observer.observe(this.sentinel);
    console.log('[FIS] Observer active, watching sentinel');
  }

  async loadBatch() {
    if (this.loading || !this.hasMore()) {
      console.log('[FIS] loadBatch skipped - loading:', this.loading, 'hasMore:', this.hasMore());
      return;
    }
    this.loading = true;
    this.showSpinner();
    console.log('[FIS] Starting loadBatch - queue:', this.queue.length, 'nextUrl:', this.nextUrl ? 'YES' : 'NO', 'batchSize:', this.batchSize);

    let appended = 0;
    try {
      while (appended < this.batchSize && this.hasMore()) {
        if (this.queue.length === 0) {
          console.log('[FIS] Queue empty, fetching next page');
          const gotMore = await this.fetchNextPage();
          if (!gotMore) {
            console.log('[FIS] No more pages to fetch');
            break;
          }
          continue;
        }
        const li = this.queue.shift();
        const id = li.dataset.productId;
        if (id && this.renderedIds.has(id)) {
          console.log('[FIS] Skipping duplicate:', id);
          continue;
        }
        if (id) this.renderedIds.add(id);
        this.grid.appendChild(li);
        appended++;
      }
    } catch (error) {
      console.error('[featured-infinite-scroll]', error);
      this.nextUrl = '';
    } finally {
      this.loading = false;
      this.hideSpinnerWithMinDelay(2000);
    }

    console.log('[FIS] Appended', appended, 'products. Total rendered:', this.renderedIds.size, 'Queue remaining:', this.queue.length);

    if (appended > 0 && typeof initializeScrollAnimationTrigger === 'function') {
      initializeScrollAnimationTrigger();
    }

    if (!this.hasMore()) {
      console.log('[FIS] No more products, finishing');
      this.finish();
    } else if (this.sentinel && this.sentinelInView()) {
      // Sentinel may still be visible (tall viewport / small batch). The observer
      // only fires on intersection changes, so keep filling until it scrolls away.
      console.log('[FIS] Sentinel still in view, scheduling another batch');
      requestAnimationFrame(() => this.loadBatch());
    }
  }

  async fetchNextPage() {
    if (this.nextUrl === '') {
      console.log('[FIS] nextUrl is empty');
      return false;
    }

    console.log('[FIS] Fetching:', this.nextUrl);
    this.showSpinner();
    const url = new URL(this.nextUrl, window.location.origin);
    url.searchParams.set('section_id', this.sectionId);

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        console.error('[FIS] Fetch failed with status:', response.status);
        this.nextUrl = '';
        this.hideSpinnerWithMinDelay(2000);
        return false;
      }

      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const fetchedGrid = doc.getElementById('product-grid');
      let added = 0;
      if (fetchedGrid) {
        fetchedGrid.querySelectorAll('li[data-product-id]').forEach((li) => {
          if (!this.renderedIds.has(li.dataset.productId)) {
            this.queue.push(li);
            added++;
          }
        });
      }
      console.log('[FIS] Fetched page - added to queue:', added);

      const fetchedRoot = doc.querySelector('featured-infinite-scroll');
      this.nextUrl = fetchedRoot ? fetchedRoot.dataset.nextUrl || '' : '';
      console.log('[FIS] Next URL updated:', this.nextUrl ? 'YES' : 'NO');

      // keep spinner visible until loadBatch finally hides it after appending
      return this.queue.length > 0 || this.nextUrl !== '';
    } catch (e) {
      console.error('[FIS] Fetch error:', e);
      this.hideSpinnerWithMinDelay(2000);
      return false;
    }
  }

  sentinelInView() {
    const rect = this.sentinel.getBoundingClientRect();
    return rect.top < window.innerHeight + 800 && rect.bottom > 0;
  }

  finish() {
    if (this.observer) this.observer.disconnect();
    if (this.spinner) this.spinner.setAttribute('hidden', '');
    if (this.endMessage && this.grid && this.grid.children.length > 0) {
      this.endMessage.removeAttribute('hidden');
    }
  }
}

if (!customElements.get('featured-infinite-scroll')) {
  customElements.define('featured-infinite-scroll', FeaturedInfiniteScroll);
}
