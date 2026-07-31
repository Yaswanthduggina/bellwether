import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver, and Recharts' ResponsiveContainer needs one.
// Reporting a fixed size is enough: these tests assert that the chart renders
// and what it renders, not its pixel geometry.
class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 900 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 400 });
