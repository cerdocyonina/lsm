export type Session = {
  username: string;
};

export type UserRecord = {
  clientName: string;
  userUuid: string;
  subscriptionToken: string;
  subscriptionUrl: string;
};

export type ServerRecord = {
  name: string;
  sortOrder: number;
  template: string;
};

export type UserFormState = {
  clientName: string;
  userUuid: string;
};

export type ServerFormState = {
  name: string;
  template: string;
};
