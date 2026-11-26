export interface Metrics {
  incr(name: string, labels?: Record<string, string>, by?: number): void;
  observe?(name: string, labels?: Record<string, string>, value?: number): void;
}
