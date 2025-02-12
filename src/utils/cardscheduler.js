/******************************************************
 * FIFOQueue:
 * Simple queue that stores an array of IDs (strings).
 ******************************************************/
class FIFOQueue {
  constructor() {
    this.items = [];
  }

  enqueue(id) {
    this.items.push(id);
  }

  dequeue() {
    return this.items.length > 0 ? this.items.shift() : null;
  }

  peek() {
    return this.items.length > 0 ? this.items[0] : null;
  }

  size() {
    return this.items.length;
  }
}

/********************************************************
 * MinHeap:
 * A min-heap of { id: string, nextReviewTime: number }.
 * - indexMap: Map<id, index> for O(1) lookups.
 * Methods:
 *   push(id, nextReviewTime)
 *   peek() -> { id, nextReviewTime } or null
 *   pop() -> { id, nextReviewTime } or null
 *   setNextReviewTime(id, newTime) -> O(log n) update
 ********************************************************/
class MinHeap {
  constructor() {
    this.heap = [];          // array of { id, nextReviewTime }
    this.indexMap = new Map(); // id => index in heap
  }

  push(id, nextReviewTime) {
    const item = { id, nextReviewTime };
    this.heap.push(item);
    const index = this.heap.length - 1;
    this.indexMap.set(id, index);
    this.bubbleUp(index);
  }

  peek() {
    return this.heap.length > 0 ? this.heap[0] : null;
  }

  pop() {
    if (this.heap.length === 0) return null;

    // Swap the root with the last item
    this.swap(0, this.heap.length - 1);
    const popped = this.heap.pop();
    this.indexMap.delete(popped.id);

    // Bubble down the new root
    if (this.heap.length > 0) {
      this.bubbleDown(0);
    }

    return popped;
  }

  setNextReviewTime(id, newTime) {
    const idx = this.indexMap.get(id);
    if (idx == null) {
      // Card not found in heap
      return;
    }
    const oldTime = this.heap[idx].nextReviewTime;
    this.heap[idx].nextReviewTime = newTime;

    if (newTime < oldTime) {
      this.bubbleUp(idx);
    } else if (newTime > oldTime) {
      this.bubbleDown(idx);
    }
  }

  // --- Internal helpers ---

  bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[i].nextReviewTime < this.heap[parent].nextReviewTime) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  bubbleDown(i) {
    const length = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;

      if (
        left < length &&
        this.heap[left].nextReviewTime < this.heap[smallest].nextReviewTime
      ) {
        smallest = left;
      }
      if (
        right < length &&
        this.heap[right].nextReviewTime < this.heap[smallest].nextReviewTime
      ) {
        smallest = right;
      }

      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  swap(a, b) {
    const temp = this.heap[a];
    this.heap[a] = this.heap[b];
    this.heap[b] = temp;

    // Update indexMap
    this.indexMap.set(this.heap[a].id, a);
    this.indexMap.set(this.heap[b].id, b);
  }
}

/**************************************************************
 * CardScheduler:
 * - newQueue: FIFOQueue of brand-new card IDs.
 * - reviewHeap: MinHeap of (id, nextReviewTime).
 *
 * popNext logic:
 *  1) If earliest scheduled card <= currentTime, pop it.
 *  2) Else if newQueue not empty, pop from FIFO.
 *  3) Else if earliest scheduled <= endOfDayTime, pop it (early review).
 *  4) Else return null.
 **************************************************************/
export class CardScheduler {
  constructor() {
    this.newQueue = new FIFOQueue();
    this.reviewHeap = new MinHeap();
  }

  /**
   * Add a brand-new card to the FIFO queue.
   * e.g. scheduler.pushNewCard('cardA');
   */
  pushNewCard(id) {
    this.newQueue.enqueue(id);
  }

  /**
   * Add a scheduled card to the min-heap.
   * e.g. scheduler.pushReviewCard('cardB', Date.now() + 600000);
   */
  pushReviewCard(id, nextReviewTime) {
    this.reviewHeap.push(id, nextReviewTime);
  }

  /**
   * Update an existing scheduled card's nextReviewTime.
   * e.g. scheduler.setReviewTime('cardB', Date.now() + 10*60*1000);
   */
  setReviewTime(id, newTime) {
    this.reviewHeap.setNextReviewTime(id, newTime);
  }

  /**
   * Return the ID of the "next" card or null if none.
   *   currentTime: number
   *   endOfDayTime: number
   * The order:
   *   1) If earliest scheduled is due now (<= currentTime), pop it.
   *   2) Else if new cards exist, pop from FIFO.
   *   3) Else if earliest scheduled <= endOfDayTime, pop it (early).
   *   4) Else return null.
   */
  popNext() {
    const currentTime = Date.now();
    const endOfDayTime = new Date().setHours(23, 59, 59, 999);
    const topScheduled = this.reviewHeap.peek();

    // 1) If earliest scheduled card is due now
    if (topScheduled && topScheduled.nextReviewTime <= currentTime) {
      return this.reviewHeap.pop().id;
    }

    // 2) Otherwise, if new cards exist
    if (this.newQueue.size() > 0) {
      return this.newQueue.dequeue();
    }

    // 3) Otherwise, if earliest scheduled is within endOfDayTime
    if (topScheduled && topScheduled.nextReviewTime <= endOfDayTime) {
      return this.reviewHeap.pop().id;
    }

    // 4) Nothing is due or new
    return null;
  }

  /**
   * Peek the ID of the next card without removing it, or null if none.
   * Follows the same logic as popNext, but doesn't modify the queue/heap.
   */
  peekNext() {
    const currentTime = Date.now();
    const endOfDayTime = new Date().setHours(23, 59, 59, 999);

    const topScheduled = this.reviewHeap.peek();

    if (topScheduled && topScheduled.nextReviewTime <= currentTime) {
      return topScheduled.id;
    }
    if (this.newQueue.size() > 0) {
      return this.newQueue.peek();
    }
    if (topScheduled && topScheduled.nextReviewTime <= endOfDayTime) {
      return topScheduled.id;
    }
    return null;
  }

  clear() {
    this.reviewHeap = new MinHeap();
    this.newQueue = new FIFOQueue();
  }
}

/******************************************************
 * Example usage (if you want to test):
 *
 * import { CardScheduler } from './CardScheduler.js';
 *
 * const scheduler = new CardScheduler();
 * const now = Date.now();
 * const endOfDay = new Date().setHours(23, 59, 59, 999);
 *
 * // 1) Add a scheduled card that is due now
 * scheduler.pushReviewCard('reviewNow', now);
 *
 * // 2) Add a scheduled card for 2 hours in the future
 * scheduler.pushReviewCard('reviewLater', now + 2 * 3600_000);
 *
 * // 3) Add a new card (no time)
 * scheduler.pushNewCard('newCardA');
 *
 * console.log(scheduler.popNext(now, endOfDay));  // -> 'reviewNow'
 * console.log(scheduler.popNext(now, endOfDay));  // -> 'newCardA'
 * console.log(scheduler.popNext(now, endOfDay));  // -> 'reviewLater'
 *
 * // If we want to reschedule 'reviewLater' again:
 * scheduler.setReviewTime('reviewLater', now + 10 * 60_000);
 ******************************************************/
