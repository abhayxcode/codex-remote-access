export type TransportTarget = {
  chatId: string | number;
  userId?: string;
};

export type TransportMessage = {
  text: string;
  options?: Record<string, any>;
};

export type Transport = {
  readonly id: string;
  readonly displayName: string;
  start(): Promise<void>;
  sendMessage(target: TransportTarget, message: TransportMessage): Promise<unknown>;
};
