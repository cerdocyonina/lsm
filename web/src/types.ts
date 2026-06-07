export type Session = {
  username: string;
  isPrimary: boolean;
};

export type AdminUserRecord = {
  id: number;
  username: string;
  isPrimary: boolean;
  createdAt: number;
};

export type ProfileRecord = {
  id: number;
  name: string;
  createdAt: number;
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
  nodeId: number | null;
};

export type NodeRecord = {
  id: number;
  name: string;
  url: string;
  inboundId: number;
  createdAt: number;
};

export type NodeTestResult = {
  ok: boolean;
  version?: string;
  commit?: string;
  date?: string;
  error?: string;
};

export type UserFormState = {
  clientName: string;
  userUuid: string;
};

export type ServerFormState = {
  name: string;
  template: string;
  nodeId: number | null;
};

export type NodeFormState = {
  name: string;
  url: string;
  secret: string;
  inboundId: string;
};

export type SyncResult = {
  nodeId?: number;
  nodeName?: string;
  result: string;
  msg?: string;
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
