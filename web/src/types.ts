export type Session = {
  username: string;
};

export type UserRecord = {
  clientName: string;
  userUuid: string;
  subscriptionToken: string;
  subscriptionUrl: string;
  createdAt: number;
};

export type ServerRecord = {
  name: string;
  sortOrder: number;
  template: string;
  createdAt: number;
};

export type UserFormState = {
  clientName: string;
  userUuid: string;
};

export type ServerFormState = {
  name: string;
  template: string;
};

export type PingResult = {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
};

export type ServerIcmpResult = {
  serverName: string;
  host: string;
  port: number;
  icmp: PingResult;
};

export type ClientServerHttpResult = {
  serverName: string;
  result: PingResult;
};

export type ClientHttpPingResult = {
  clientName: string;
  userUuid: string;
  servers: ClientServerHttpResult[];
};

export type PingResponse = {
  icmp: ServerIcmpResult[] | null;
  http: ClientHttpPingResult[] | null;
};
