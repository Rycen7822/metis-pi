export class BlockRefIssuer {
    next = 1;
    issue() {
        return `b${this.next++}`;
    }
    rebuildFrom(existingBlockIds) {
        if (existingBlockIds.length === 0) {
            this.next = 1;
            return;
        }
        const max = Math.max(...existingBlockIds.map((id) => parseInt(id.slice(1), 10)));
        this.next = max + 1;
    }
}
