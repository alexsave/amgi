import { getEndOfDayTimestamp } from './dates';

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
 *   delete(id) -> boolean
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

  /**
   * Delete an item from the heap by its id.
   * Returns true if found and deleted, false otherwise.
   */
  delete(id) {
    const idx = this.indexMap.get(id);
    if (idx == null) {
      return false;
    }

    // If it's the last element, just pop it
    if (idx === this.heap.length - 1) {
      this.heap.pop();
      this.indexMap.delete(id);
      return true;
    }

    // Otherwise:
    // 1. Swap with last element
    // 2. Pop last element
    // 3. Bubble down or up the swapped element
    this.swap(idx, this.heap.length - 1);
    this.heap.pop();
    this.indexMap.delete(id);

    if (this.heap.length > 0 && idx < this.heap.length) {
      // Need to check if we should bubble up or down
      const parent = Math.floor((idx - 1) / 2);
      if (parent >= 0 && this.heap[idx].nextReviewTime < this.heap[parent].nextReviewTime) {
        this.bubbleUp(idx);
      } else {
        this.bubbleDown(idx);
      }
    }
    return true;
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
 * - learningHeap: MinHeap of learning cards.
 * - newQueue: FIFOQueue of brand-new card IDs.
 * - reviewHeap: MinHeap of (id, nextReviewTime).
 * - cardsMap: Map of all cards by ID (single source of truth)
 *
 * popNext logic:
 *  1) If earliest scheduled card <= currentTime, pop it.
 *  2) Else if newQueue not empty, pop from FIFO.
 *  3) Else if earliest scheduled <= endOfDayTime, pop it (early review).
 *  4) Else return null.
 **************************************************************/
export class CardScheduler {
  constructor() {
    this.learningHeap = new MinHeap(); // Highest priority
    this.newQueue = new FIFOQueue();   // Second priority
    this.reviewHeap = new MinHeap();   // Lowest priority
    this.cardsMap = new Map();         // Map of all cards by ID (single source of truth)
  }

  /**
   * Add a brand-new card to the FIFO queue.
   */
  pushNewCard(card) {
    const id = card.id;
    this.cardsMap.set(id, card);
    this.newQueue.enqueue(id);
  }

  /**
   * Add or update a card's review time in the appropriate heap.
   * If the card is in any other queue/heap, it will be moved.
   */
  setReviewTime(card, nextReviewTime, cardState = 'review') {
    const id = card.id;
    // Store the card in our cards map
    this.cardsMap.set(id, card);
    
    // First remove from any existing queue/heap
    this.newQueue.items = this.newQueue.items.filter(x => x !== id);
    this.learningHeap.delete(id);
    this.reviewHeap.delete(id);

    // Then add to appropriate queue/heap
    if (cardState === 'learning') {
      this.learningHeap.push(id, nextReviewTime);
    } else if (cardState === 'new') {
      this.newQueue.enqueue(id);
    } else if (cardState === 'review') {
      this.reviewHeap.push(id, nextReviewTime);
    }
    this.printSummary();
  }

  /**
   * Update a card's review information
   */
  setReview(card, review) {
    card.review = review;

    // Update the card's position in the appropriate queue/heap
    let nextReviewTime;
    
    if (review.next_review_date) {
      // Handle ISO date parsing in a more robust way
      try {
        // Use the built-in Date parsing for ISO strings, which handles timezones correctly
        const date = new Date(review.next_review_date);
        
        // Check if the date is valid
        if (!isNaN(date.getTime())) {
          nextReviewTime = date.getTime();
        } else {
          // Fallback if date is invalid
          console.error('Invalid date:', review.next_review_date);
          nextReviewTime = Date.now();
        }
      } catch (e) {
        console.error('Error parsing date:', e);
        nextReviewTime = Date.now();
      }
    } else {
      nextReviewTime = Date.now();
    }
    
    console.log('setReview for card:', { 
      id: card.id,
      card_state: review.card_state,
      next_review_date: review.next_review_date,
      parsed_local_time: new Date(nextReviewTime).toLocaleString(),
      nextReviewTime: new Date(nextReviewTime).toISOString(),
      isReviewDue: nextReviewTime <= new Date(getEndOfDayTimestamp()).getTime(),
      currentTime: new Date().toISOString(),
      endOfDay: getEndOfDayTimestamp()
    });
    
    this.setReviewTime(card, nextReviewTime, review.card_state);
  }

  /**
   * Get the full card by ID
   */
  getFullCard(id) {
    return this.cardsMap.get(id) || null;
  }

  /**
   * Get the current state of a card in the scheduler
   * Returns 'new', 'learning', 'review' or null if not found
   */
  getCardState(id) {
    // Check new queue
    if (this.newQueue.items.includes(id)) {
      return 'new';
    }
    
    // Check learning heap
    const learningIndex = this.learningHeap.indexMap.get(id);
    if (learningIndex !== undefined) {
      return 'learning';
    }
    
    // Check review heap
    const reviewIndex = this.reviewHeap.indexMap.get(id);
    if (reviewIndex !== undefined) {
      return 'review';
    }
    
    // Not found in any queue
    return null;
  }

  /**
   * Delete a card from any queue/heap it might be in.
   */
  delete(id) {
    let found = false;
    
    // Remove from the cardsMap
    const wasInMap = this.cardsMap.delete(id);
    if (wasInMap) found = true;
    
    // Check new queue
    const newQueueIndex = this.newQueue.items.indexOf(id);
    if (newQueueIndex !== -1) {
      this.newQueue.items.splice(newQueueIndex, 1);
      found = true;
    }

    // Check learning heap
    if (this.learningHeap.delete(id)) {
      found = true;
    }

    // Check review heap
    if (this.reviewHeap.delete(id)) {
      found = true;
    }

    this.printSummary();
    return found;
  }

  /**
   * Return the card for the "next" ID or null if none.
   * Priority order:
   * 1. Learning cards due now
   * 2. New cards
   * 3. Review cards due today
   */
  popNext() {
    const currentTime = Date.now();
    const endOfDayTime = new Date(getEndOfDayTimestamp()).getTime();

    // 1. First priority: Learning cards due now
    const topLearning = this.learningHeap.peek();
    if (topLearning && topLearning.nextReviewTime <= currentTime) {
      const learningCardItem = this.learningHeap.pop();
      return this.getFullCard(learningCardItem.id);
    }

    // 2. Second priority: New cards
    if (this.newQueue.size() > 0) {
      const newCardId = this.newQueue.dequeue();
      return this.getFullCard(newCardId);
    }

    // 3. Third priority: Review cards due today
    const topReview = this.reviewHeap.peek();
    if (topReview && topReview.nextReviewTime <= endOfDayTime) {
      const reviewCardItem = this.reviewHeap.pop();
      return this.getFullCard(reviewCardItem.id);
    }

    // 4. Finally, check for any remaining learning cards
    if (topLearning) {
      const learningCardItem = this.learningHeap.pop();
      return this.getFullCard(learningCardItem.id);
    }

    return null;
  }

  /**
   * Peek the ID of the next card without removing it.
   */
  peekNext() {
    const currentTime = Date.now();
    const endOfDayTime = new Date(getEndOfDayTimestamp()).getTime();

    console.log('CardScheduler.peekNext:', { 
      currentTime: new Date(currentTime).toISOString(),
      endOfDayTime: new Date(endOfDayTime).toISOString(),
      learningHeapSize: this.learningHeap.heap.length,
      newQueueSize: this.newQueue.size(),
      reviewHeapSize: this.reviewHeap.heap.length
    });

    const topLearning = this.learningHeap.peek();
    if (topLearning && topLearning.nextReviewTime <= currentTime) {
      console.log('Returning learning card (due now):', topLearning.id);
      return topLearning.id;
    }

    if (this.newQueue.size() > 0) {
      console.log('Returning new card:', this.newQueue.peek());
      return this.newQueue.peek();
    }

    const topReview = this.reviewHeap.peek();

    if (topReview) {
      console.log('Top review card:', { 
        id: topReview.id,
        nextReviewTime: new Date(topReview.nextReviewTime).toISOString(),
        isDue: topReview.nextReviewTime <= endOfDayTime
      });
    }

    if (topReview && topReview.nextReviewTime <= endOfDayTime) {
      console.log('Returning review card (due today):', topReview.id);
      return topReview.id;
    }

    if (topLearning) {
      console.log('Returning learning card (not due yet):', topLearning.id);
      return topLearning.id;
    }

    console.log('No cards to return');
    return null;
  }

  getLearningCardsCount() {
    return this.learningHeap.heap.length;
  }

  getNewCardsCount() {
    return this.newQueue.size();
  }

  getReviewCardsCount() {
    return this.reviewHeap.heap.length;
  }

  getTotalCardsCount() {
    return this.getLearningCardsCount() + this.getNewCardsCount() + this.getReviewCardsCount();
  }

  clear() {
    this.learningHeap = new MinHeap();
    this.newQueue = new FIFOQueue();
    this.reviewHeap = new MinHeap();
    this.cardsMap = new Map();
  }

  printSummary() {
  }
}
