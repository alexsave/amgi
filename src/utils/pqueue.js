export class PriorityQueue {
    constructor(comparator = (a, b) => a.priority < b.priority) {
        this.heap = [];
        this.map = new Map();  // Tracks value -> index in heap
        this.comparator = comparator;
    }

    setPriority(value, priority) {
        if (this.map.has(value)) {
            const index = this.map.get(value);
            const oldPriority = this.heap[index].priority;
            this.heap[index].priority = priority;
            
            // Determine if priority increased or decreased
            const oldElem = { value, priority: oldPriority };
            const newElem = { value, priority };
            if (this.comparator(newElem, oldElem)) {
                this._bubbleUp(index);
            } else {
                this._bubbleDown(index);
            }
        } else {
            const element = { value, priority };
            this.heap.push(element);
            this.map.set(value, this.heap.length - 1);
            this._bubbleUp(this.heap.length - 1);
        }
    }

    peek() {
        return this.heap.length > 0 ? this.heap[0].value : null;
    }

    pop() {
        if (this.heap.length === 0) return null;
        
        // Remove top element
        const top = this.heap[0];
        this.map.delete(top.value);
        
        // Replace with last element
        if (this.heap.length > 1) {
            const last = this.heap.pop();
            this.heap[0] = last;
            this.map.set(last.value, 0);
            this._bubbleDown(0);
        } else {
            this.heap.pop();
        }
        
        return top.value;
    }

    _bubbleUp(index) {
        while (index > 0) {
            const parentIndex = (index - 1) >> 1;
            if (this.comparator(this.heap[index], this.heap[parentIndex])) {
                this._swap(index, parentIndex);
                index = parentIndex;
            } else {
                break;
            }
        }
    }

    _bubbleDown(index) {
        const lastIndex = this.heap.length - 1;
        while (true) {
            const left = 2 * index + 1;
            const right = 2 * index + 2;
            let target = index;
            
            if (left <= lastIndex && this.comparator(this.heap[left], this.heap[target])) {
                target = left;
            }
            if (right <= lastIndex && this.comparator(this.heap[right], this.heap[target])) {
                target = right;
            }
            
            if (target !== index) {
                this._swap(index, target);
                index = target;
            } else {
                break;
            }
        }
    }

    _swap(i, j) {
        [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
        this.map.set(this.heap[i].value, i);
        this.map.set(this.heap[j].value, j);
    }

    get size() {
        return this.heap.length;
    }
}