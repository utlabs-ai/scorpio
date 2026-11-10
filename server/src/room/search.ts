// Search (docs/api/messages.md): a thin composer. Each domain searches its own data with its own function (messages.search,
// tasks.searchItems, files.searchFiles) and reads another domain's only through the views it publishes (member_names_v,
// message_files_v); here the topic is checked, then the reader, then each group in the order of the answer. RoomDO
// holds it through RoomDO.searchOf(o) (split by domain S8b).
import { resolveFilters } from "../search";
import { wrap } from "./kernel";
import type { Actor, Result, Row } from "./kernel";
import type { SearchGroup, SearchPage, SearchQuery, SearchResults } from "../search";

export interface SearchDeps {
  room: { require(): Row };
  members: { reader(actor: Actor): Row | null; get(name: string): Row | undefined };
  messages: { search(p: SearchQuery): SearchPage };
  tasks: { searchItems(p: SearchQuery): SearchPage };
  files: { searchFiles(p: SearchQuery): SearchPage };
  memo: { search(p: SearchQuery): SearchPage };
}

export class Search {
  constructor(private readonly d: SearchDeps) {}

  /** Search the history this actor can read. Archived rooms remain searchable from inside the room. */
  async search(actor: Actor, p: SearchQuery): Promise<Result<SearchResults>> {
    return wrap(() => {
      const room = this.d.room.require();
      // A signed-in visitor can read a public room without joining it (a viewer). Private rooms need membership.
      this.d.members.reader(actor);
      p = resolveFilters(p, actor.name, n => this.d.members.get(n));
      const groups: SearchResults["groups"] = { messages: [], todo: [], files: [], memo: [] };
      const hasMore: SearchResults["hasMore"] = { messages: false, todo: false, files: false, memo: false };
      // A group that in= leaves out is not searched: it stays [] and false.
      const collect = (group: SearchGroup, search: () => SearchPage) => {
        if ((p.in && p.in !== group) || (p.groups && !p.groups.includes(group))) return;
        const found = search();
        hasMore[group] = found.hasMore;
        groups[group] = found.hits;
      };
      collect("messages", () => this.d.messages.search(p));
      collect("todo", () => this.d.tasks.searchItems(p));
      collect("files", () => this.d.files.searchFiles(p));
      collect("memo", () => this.d.memo.search(p));
      return { roomId: room.id as string, q: p.q, groups, hasMore };
    });
  }
}
