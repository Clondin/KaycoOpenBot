export type KnowledgeActor = {
  userId: string;
  email?: string;
  groups: string[];
};

export type KnowledgeAclEntry = {
  principal: string;
  effect: "allow" | "deny";
};
