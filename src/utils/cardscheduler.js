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

/**
 * How far ahead of its step a learning card may be pulled when there is
 * nothing else to show. Anki's learn-ahead limit, same default. Without a
 * bound a card graded Again came straight back and the step meant nothing.
 */
export const LEARN_AHEAD_MINUTES = 20;

/**
 * A translation pair generates two cards, A->B and B->A, which share their
 * text and their audio. Ordering the two sides gives both of them the same
 * key, so siblings can be found without a pair_id column. The scheduler only
 * ever holds one deck, so the key does not need a deck id.
 */
const siblingKey = (card) => JSON.stringify(
  [(card?.front_text || '').trim(), (card?.back_text || '').trim()].sort()
);

/**************************************************************
 * CardScheduler:
 * - learningHeap: MinHeap of learning cards.
 * - newQueue: FIFOQueue of brand-new card IDs.
 * - reviewHeap: MinHeap of (id, nextReviewTime).
 * - cardsMap: Map of all cards by ID (single source of truth)
 *
 * Selection order:
 *  1) Learning cards whose step is up.
 *  2) New cards, while the daily new-card budget lasts.
 *  3) Review cards due by end of day.
 *  4) Learning cards within the learn-ahead window (nothing else left).
 * Buried siblings are skipped in every tier unless they are all that remain.
 **************************************************************/
export class CardScheduler {
  constructor() {
    this.learningHeap = new MinHeap(); // Highest priority
    this.newQueue = new FIFOQueue();   // Second priority
    this.reviewHeap = new MinHeap();   // Lowest priority
    this.cardsMap = new Map();         // Map of all cards by ID (single source of truth)
    this.idsBySiblingKey = new Map();  // sibling key => Set of card ids
    this.buriedIds = new Set();        // siblings already answered this session
    this.newCardsRemaining = Infinity; // until a daily budget is supplied
  }

  /**
   * Daily budget of new cards still available to this session. Callers get it
   * from the user's preference minus what the day has already used.
   */
  setNewCardBudget(remaining) {
    this.newCardsRemaining = Number.isFinite(remaining) ? Math.max(0, remaining) : Infinity;
  }

  /**
   * Add a brand-new card to the FIFO queue.
   */
  pushNewCard(card) {
    const id = card.id;
    this.indexCard(card);
    this.newQueue.enqueue(id);
  }

  /**
   * Add or update a card's review time in the appropriate heap.
   * If the card is in any other queue/heap, it will be moved.
   */
  setReviewTime(card, nextReviewTime, cardState = 'review') {
    const id = card.id;
    // Store the card in our cards map
    this.indexCard(card);

    // First remove from any existing queue/heap
    this.removeFromQueues(id);

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

    this.setReviewTime(card, nextReviewTime, review.card_state);
  }

  /**
   * Record that a card has been graded. This is the moment a new card counts
   * against the daily budget, and the moment its sibling stops being worth
   * showing: the pair share their text and their audio, so the reverse card
   * straight after the forward one is an echo, not recall.
   *
   * Must be called while the card is still in the scheduler.
   *
   * @returns {string[]} ids buried by this answer
   */
  recordAnswer(cardId) {
    if (this.getCardState(cardId) === 'new') {
      this.newCardsRemaining = Math.max(0, this.newCardsRemaining - 1);
    }
    return this.burySiblingsOf(cardId);
  }

  /**
   * Bury every other card that came from the same translation pair.
   */
  burySiblingsOf(cardId) {
    const card = this.cardsMap.get(cardId);
    if (!card) return [];

    const siblings = this.idsBySiblingKey.get(siblingKey(card));
    if (!siblings) return [];

    const buried = [];
    for (const otherId of siblings) {
      if (otherId !== cardId) {
        this.buriedIds.add(otherId);
        buried.push(otherId);
      }
    }
    return buried;
  }

  isBuried(id) {
    return this.buriedIds.has(id);
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

    const card = this.cardsMap.get(id);
    if (card) {
      this.unindexCard(card);
      found = true;
    }

    if (this.removeFromQueues(id)) {
      found = true;
    }

    this.printSummary();
    return found;
  }

  /**
   * Return the card for the "next" ID or null if none.
   */
  popNext() {
    const id = this.selectNextId();
    if (id === null) return null;

    this.removeFromQueues(id);
    return this.getFullCard(id);
  }

  /**
   * Peek the ID of the next card without removing it.
   */
  peekNext() {
    return this.selectNextId();
  }

  /**
   * Candidate ids for this moment, most urgent tier first.
   *
   * `dueTiers` are cards the session actually owes the reviewer. `learnAhead`
   * is the last resort: learning cards pulled in ahead of their step, which
   * is only ever better than ending the session.
   */
  candidateTiers() {
    const currentTime = Date.now();
    const endOfDayTime = new Date(getEndOfDayTimestamp()).getTime();
    const learnAheadTime = currentTime + LEARN_AHEAD_MINUTES * 60 * 1000;

    const dueBy = (heap, cutoff) => heap.heap
      .filter(item => item.nextReviewTime <= cutoff)
      .sort((a, b) => a.nextReviewTime - b.nextReviewTime)
      .map(item => item.id);

    return {
      dueTiers: [
        dueBy(this.learningHeap, currentTime),
        this.newCardsRemaining > 0 ? [...this.newQueue.items] : [],
        dueBy(this.reviewHeap, endOfDayTime)
      ],
      learnAhead: dueBy(this.learningHeap, learnAheadTime)
    };
  }

  selectNextId() {
    const { dueTiers, learnAhead } = this.candidateTiers();

    for (const tier of dueTiers) {
      const next = tier.find(id => !this.isBuried(id));
      if (next !== undefined) return next;
    }

    // Only buried siblings are due. Showing one beats repeating the card that
    // buried it, so they outrank the learn-ahead tier.
    for (const tier of dueTiers) {
      if (tier.length > 0) return tier[0];
    }

    const early = learnAhead.find(id => !this.isBuried(id));
    if (early !== undefined) return early;

    return learnAhead.length > 0 ? learnAhead[0] : null;
  }

  getLearningCardsCount() {
    return this.learningHeap.heap.length;
  }

  /**
   * New cards this session can still introduce, not new cards in the deck -
   * anything past the daily budget will not be shown, so counting it would
   * only mislead the review screen.
   */
  getNewCardsCount() {
    return Math.min(this.newQueue.size(), this.newCardsRemaining);
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
    this.idsBySiblingKey = new Map();
    this.buriedIds = new Set();
    this.newCardsRemaining = Infinity;
  }

  // --- Internal helpers ---

  indexCard(card) {
    this.cardsMap.set(card.id, card);

    const key = siblingKey(card);
    if (!this.idsBySiblingKey.has(key)) {
      this.idsBySiblingKey.set(key, new Set());
    }
    this.idsBySiblingKey.get(key).add(card.id);
  }

  unindexCard(card) {
    this.cardsMap.delete(card.id);

    const key = siblingKey(card);
    const siblings = this.idsBySiblingKey.get(key);
    if (siblings) {
      siblings.delete(card.id);
      if (siblings.size === 0) {
        this.idsBySiblingKey.delete(key);
      }
    }
  }

  removeFromQueues(id) {
    const wasNew = this.newQueue.items.includes(id);
    if (wasNew) {
      this.newQueue.items = this.newQueue.items.filter(x => x !== id);
    }
    const wasLearning = this.learningHeap.delete(id);
    const wasReview = this.reviewHeap.delete(id);

    return wasNew || wasLearning || wasReview;
  }

  printSummary() {
  }
}
