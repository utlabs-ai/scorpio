// RoomDO: one Durable Object per topic. Its domains live in room/ (topic, members, presence, messages, tasks, files,
// schedules, handoffs, quota, snapshot, retention, lifecycle, search), each over the topic's SQLite storage and its
// live connections (browsers and agents in `wait`, on the WebSocket Hibernation API so an idle topic costs nothing).
// RoomDO keeps the lifecycle, builds domains over their deps and forwards each RPC to its owner. Scheduled work uses
// alarms; only active workspace transfers use bounded in-memory deadlines, cleared when pending work ends.

import type { Ticket } from "./view-ticket";
import { DurableObject } from "cloudflare:workers";
import { now } from "./util";
import type { FileMeta } from "./files";
import type { Limits, Plan } from "./plans";
import type { SearchQuery, SearchResults } from "./search";
import type { RoomData } from "./my-data";
import type { OpenItem } from "./item-thread";
import type { Brief } from "./task-brief";
import type { IndexState } from "./room-index-fix";
import { Timers, remember, replay, safeSend, wrap } from "./room/kernel";
import type { ApprovalAnswerResult } from "./room-approvals";
import { Approvals } from "./room/approvals";
import { Handoffs } from "./room/handoffs";
import { Schedules } from "./room/schedules";
import { Quota } from "./room/quota";
import { Snapshot } from "./room/snapshot";
import { Retention } from "./room/retention";
import { Files } from "./room/files";
import { Tasks } from "./room/tasks";
import { Members } from "./room/members";
import { Presence } from "./room/presence";
import { Lifecycle } from "./room/lifecycle";
import { Memos } from "./room/memo";
import { Messages } from "./room/messages";
import { Room } from "./room/room";
import { OVERVIEW_WINDOW_MS, overviewOf, type Overview } from "./room/overview";
import type { LaneAnswer } from "./room/members";
import { Search } from "./room/search";
import { Export } from "./room/export";
import { Workspace } from "./room/workspace";
import type { ExportHead, ExportPart } from "./room/export";
export type { ExportHead, ExportPart, ExportTopic } from "./room/export";
import type { NewMessage } from "./room/messages";
import type { ListFilesQuery, ListFilesResult, FileView } from "./room/files";
export type { ListFilesQuery, ListedFile, ListFilesResult, FileView } from "./room/files";
import type { Actor, Result, Row } from "./room/kernel";
export type { Actor, ActorKind, Result } from "./room/kernel";
import type { Counts, Handoff, HandoffView, Item, Member, Message, RoomInfo, RoomSummary, ScheduleOp, SendOp, TodoOp } from "./room/types";
import type { CalendarTopic } from "./calendar";
export type { SystemEvent, Message, Item, Counts, Deleted, Round, Member, Handoff, HandoffView, RoomInfo, RoomSummary, SendOp, ScheduleOp, TodoOp } from "./room/types";

export class RoomDO extends DurableObject<Env> {
  // ---------- fields, and the domains each built once over its deps ----------

  private sql: SqlStorage;
  private readonly handoffs: Handoffs;
  private _approvals?: Approvals;
  private _scheduler?: Schedules;
  private _timers?: Timers;
  private _quota?: Quota;
  private _snapshot?: Snapshot;
  private _retention?: Retention;
  private _files?: Files;
  private _tasks?: Tasks;
  private _members?: Members;
  private _presence?: Presence;
  private _lifecycle?: Lifecycle;
  private _messages?: Messages;
  private _room?: Room;
  private _search?: Search;
  private _memo?: Memos;
  private _export?: Export;
  private _workspace?: Workspace;

  private static workspaceOf(o: RoomDO): Workspace {
    return (o._workspace ??= new Workspace({
      ctx: () => o.ctx, room: () => o.roomInfo(), member: name => o.memberRow(name),
      computers: actor => RoomDO.membersOf(o).workspaceComputers(actor),
      recovery: () => RoomDO.membersOf(o).workspaceRecovery(),
    }));
  }

  private static memoOf(o: RoomDO): Memos {
    return (o._memo ??= new Memos({
      sql: () => o.sql, ctx: () => o.ctx, schedule: (key, ms) => o.schedule(key, ms),
      room: { requireWritable: () => o.requireWritable(), id: () => o.roomInfo().id },
      members: { reader: (actor) => o.reader(actor), require: (actor) => o.requireMember(actor) },
      messages: { exists: (seq) => RoomDO.messagesIn(o).sourceExists(seq), writeMemo: (seq, value) => RoomDO.messagesIn(o).writeMemo(seq, value) },
      tasks: { exists: (n) => RoomDO.tasksOf(o).sourceExists(n) },
    }));
  }

  // Room's own lookup is require(); RoomDO's room() forwards to it, and Room's deps come back through o.room(), so
  // room-membership's requireOwner on a fake still asks the fake's room. Other domains' room deps keep calling RoomDO's
  // names (room-snapshot overrides isPublicRoom on its fake); only the five room writes in lifecycleOf go to Room.
  private static roomOf(o: RoomDO): Room {
    return (o._room ??= new Room({
      sql: () => o.sql,
      ctx: () => o.ctx,
      env: () => o.env,
      schedule: (task, ms) => o.schedule(task, ms),
      require: () => o.room(),
      members: {
        require: (actor) => o.requireMember(actor),
        get: (name) => o.memberRow(name),
        touch: (name) => o.touch(name),
        addOwner: (owner, at) => RoomDO.membersOf(o).addOwner(owner, at),
        accounts: () => RoomDO.membersOf(o).accounts(),
        accountKnown: (account) => RoomDO.membersOf(o).accountKnown(account),
        activeCount: (kind) => RoomDO.membersOf(o).activeCount(kind),
        workingAgents: () => RoomDO.membersOf(o).workingAgents(),
      },
      presence: { isViewer: (ws) => o.isViewer(ws), broadcastHostRooms: () => RoomDO.presenceOf(o).broadcastHostRooms(), workOf: (r, except) => o.workOf(r, except) },
      snapshot: { publicChanged: () => o.publicChanged(), madePrivate: () => RoomDO.snapshotOf(o).madePrivate() },
      tasks: { counts: () => o.counts(), openItems: () => o.openItems() },
      quota: { messagesToday: () => o.messagesToday() },
      messages: {
        mentionUnread: (name, cursor) => o.mentionUnread(name, cursor),
        lastTs: () => RoomDO.messagesIn(o).lastTs(),
        unreadFor: (handle, cursor) => RoomDO.messagesIn(o).unreadFor(handle, cursor),
      },
      lifecycle: { markDeleted: (why) => o.markDeleted(why) },
      insertMessage: (m) => o.insertMessage(m),
    }));
  }

  private static approvalsOf(o: RoomDO): Approvals {
    return (o._approvals ??= new Approvals({
      sql: () => o.sql, ctx: () => o.ctx, env: () => o.env,
      schedule: (task, ms) => o.schedule(task, ms), room: () => o.roomInfo(),
      member: (name) => o.memberRow(name), hosts: (names) => RoomDO.membersOf(o).approvalHosts(names), reader: (actor) => o.reader(actor),
    }));
  }

  private static filesOf(o: RoomDO): Files {
    return (o._files ??= new Files({
      sql: () => o.sql,
      ctx: () => o.ctx,
      env: () => o.env,
      schedule: (task, ms) => o.schedule(task, ms),
      room: { require: () => o.room(), requireWritable: () => o.requireWritable(), row: () => o.roomRow(), info: () => o.roomInfo() },
      members: { get: (name) => o.memberRow(name), require: (actor) => o.requireMember(actor), reader: (actor) => o.reader(actor) },
      messages: { insert: (m) => o.insertMessage(m), markFile: (seq, id, at) => o.markFileInMessage(seq, id, at) },
    }));
  }

  private static tasksOf(o: RoomDO): Tasks {
    return (o._tasks ??= new Tasks({
      sql: () => o.sql,
      ctx: () => o.ctx,
      env: () => o.env,
      schedule: (task, ms) => o.schedule(task, ms),
      room: { require: () => o.room(), requireWritable: () => o.requireWritable(), info: () => o.roomInfo() },
      members: {
        get: (name) => o.memberRow(name),
        reader: (actor) => o.reader(actor),
        require: (actor) => o.requireMember(actor),
        touch: (name) => o.touch(name),
        activeNameSet: () => RoomDO.membersOf(o).activeNameSet(),
        findCaseless: (name) => RoomDO.membersOf(o).findCaseless(name),
        findCaselessName: (name) => RoomDO.membersOf(o).findCaselessName(name),
      },
      quota: { ownerLimits: () => o.ownerLimits() },
      files: { withLinks: (files) => RoomDO.filesOf(o).withLinks(files) },
    }));
  }

  private static membersOf(o: RoomDO): Members {
    return (o._members ??= new Members({
      sql: () => o.sql,
      ctx: () => o.ctx,
      wrap: (fn) => o.wrap(fn),
      room: () => o.room(),
      roomInfo: (r) => o.roomInfo(r),
      checkCode: (r, code, account) => o.checkCode(r, code, account),
      lastSeq: () => o.lastSeq(),
      replay: (sender, nonce) => o.replay(sender, nonce),
      remember: (sender, nonce, result) => o.remember(sender, nonce, result),
      yours: (name) => o.yours(name),
      systemMessage: (type, name) => o.systemMessage(type, name),
      insertMessage: (m) => o.insertMessage(m),
      publicChanged: () => o.publicChanged(),
      broadcastMembers: () => o.broadcastMembers(),
      presence: { isOnline: (name, kind, except) => o.isOnline(name, kind, except), workOf: (r, except) => o.workOf(r, except) },
      messages: { takeoverCandidates: (owner, role, afterSeq) => o.takeoverCandidates(owner, role, afterSeq), renamedEvents: () => o.renamedEvents() },
      handoffs: { dropSeats: (names) => o.handoffs.dropSeats(names) },
      tasks: { reassignEvictedSeats: (seats) => RoomDO.tasksOf(o).reassignEvictedSeats(seats), todoChanged: () => RoomDO.tasksOf(o).todoChanged() },
    }));
  }

  // Presence's writes to members columns go to members' functions directly: they are new, no fake-object test has them,
  // and none reaches fetch, carry, setWork or afterDisconnect.
  private static presenceOf(o: RoomDO): Presence {
    return (o._presence ??= new Presence({
      workspace: { hostConnected: ws => RoomDO.workspaceOf(o).hostConnected(ws), revokedHost: ws => RoomDO.workspaceOf(o).revokedHost(ws) },
      ctx: () => o.ctx,
      env: () => o.env,
      schedule: (task, ms) => o.schedule(task, ms),
      room: { require: () => o.room(), info: () => o.roomInfo(), memberView: () => o.memberRoomView() },
      members: {
        get: (name) => o.memberRow(name),
        reader: (actor) => o.reader(actor),
        require: (actor) => o.requireMember(actor),
        all: (except) => o.allMembers(except),
        touch: (name) => o.touch(name),
        setOnline: (host) => RoomDO.membersOf(o).setOnline(host),
        dropCarrier: (name, host) => RoomDO.membersOf(o).dropCarrier(name, host),
        writeWork: (name, work, since, reason) => RoomDO.membersOf(o).writeWork(name, work, since, reason),
        writePerm: (name, perm) => RoomDO.membersOf(o).writePerm(name, perm),
        setCarried: (host, names) => RoomDO.membersOf(o).setCarried(host, names),
        setOffline: (host, at) => RoomDO.membersOf(o).setOffline(host, at),
      },
      messages: {
        of: (rows, viewer) => o.messagesOf(rows, viewer),
        pending: (name, cursor) => o.pending(name, cursor),
        envelope: (m) => o.envelope(m),
        mentionUnread: (name, cursor) => o.mentionUnread(name, cursor),
        lastHumanTs: () => RoomDO.messagesIn(o).lastHumanTs(),
        recent: (n) => RoomDO.messagesIn(o).recent(n),
      },
      tasks: { todoState: () => o.todoState(), todoFrame: () => o.todoFrame() },
      memo: { state: () => RoomDO.memoOf(o).state(), frame: () => RoomDO.memoOf(o).frame() },
      approvals: {
        offline: () => RoomDO.approvalsOf(o).hostOffline(),
        dropHost: (name) => RoomDO.approvalsOf(o).dropHost(name),
        browser: (ws) => RoomDO.approvalsOf(o).connectBrowser(ws),
        host: (ws) => RoomDO.approvalsOf(o).connectHost(ws),
        open: (ws, approval) => RoomDO.approvalsOf(o).open(ws, approval),
        close: (ws, frame) => RoomDO.approvalsOf(o).close(ws, frame),
        blockedOf: (handle, names) => RoomDO.approvalsOf(o).blockedOf(handle, names),
        closedAt: (handle, name) => RoomDO.approvalsOf(o).closedAt(handle, name),
      },
      schedules: { count: () => o.scheduler.scheduleCount() },
      quota: { ownerLimits: () => o.ownerLimits(), view: (plan, lim) => o.quotaView(plan, lim) },
    }));
  }

  private static quotaOf(o: RoomDO): Quota {
    return (o._quota ??= new Quota({
      ctx: () => o.ctx,
      env: () => o.env,
      room: () => o.room(),
      roomInfo: () => o.roomInfo(),
      countSince: (ts, afterSeq) => o.countSince(ts, afterSeq),
      countMinuteSince: (ts) => RoomDO.messagesIn(o).countMinuteSince(ts),
      safeSend: (ws, data) => o.safeSend(ws, data),
    }));
  }

  private static snapshotOf(o: RoomDO): Snapshot {
    return (o._snapshot ??= new Snapshot({
      ctx: () => o.ctx,
      env: () => o.env,
      schedule: (task, ms) => o.schedule(task, ms),
      room: { require: () => o.room(), isPublic: () => o.isPublicRoom(), idOrNull: () => RoomDO.roomOf(o).idOrNull() },
      messages: { lastSeq: () => o.lastSeq(), latestForSnapshot: (n) => RoomDO.messagesIn(o).latestForSnapshot(n) },
      members: { displayNames: () => RoomDO.membersOf(o).displayNames() },
    }));
  }

  private static retentionOf(o: RoomDO): Retention {
    return (o._retention ??= new Retention({
      room: {
        require: () => o.room(),
        row: () => o.roomRow(),
        markDeleted: (why) => o.markDeleted(why),
      },
      messages: { lastCountedAt: (r) => o.lastCountedAt(r) },
      lifecycle: { archiveRoom: (reason, at) => RoomDO.lifecycleOf(o).archiveRoom(reason, at) },
    }));
  }

  // Every dep reads the RoomDO name at call time: room-membership, own-computer, room-retention and schedule-room drive
  // these operations on fakes that override those names (wrap included: theirs throws the refusal). Members' functions
  // go to Members directly, since own-computer's fake has none of them; room's writes go to Room's, which run on the
  // fake's sql.
  private static lifecycleOf(o: RoomDO): Lifecycle {
    return (o._lifecycle ??= new Lifecycle({
      workspace: { revokeAccount: account => RoomDO.workspaceOf(o).revokeAccount(account), revokeComputer: (account, id) => RoomDO.workspaceOf(o).revokeComputer(account, id), revokeAll: () => RoomDO.workspaceOf(o).revokeAll() },
      ctx: () => o.ctx,
      wrap: (fn) => o.wrap(fn),
      safeSend: (ws, data) => o.safeSend(ws, data),
      room: {
        require: () => o.room(),
        requireOwner: (actor, what) => o.requireOwner(actor, what),
        info: () => o.roomInfo(),
        memberView: () => o.memberRoomView(),
        broadcast: (hosts) => o.broadcastRoom(hosts),
        setArchived: (at) => RoomDO.roomOf(o).writeArchived(at),
        planArchive: (at, reason) => RoomDO.roomOf(o).writePlanArchive(at, reason),
        planRestore: () => RoomDO.roomOf(o).writeRestore(),
        retentionArchive: (at) => RoomDO.roomOf(o).writeRetentionArchive(at),
        setDeleted: (at) => RoomDO.roomOf(o).writeDeleted(at),
        dropAccountFailures: (account) => RoomDO.roomOf(o).dropAccountFailures(account),
      },
      members: {
        require: (actor) => o.requireMember(actor),
        get: (name) => o.memberRow(name),
        setLeft: (name, at) => RoomDO.membersOf(o).setLeft(name, at),
        accountActive: (account) => RoomDO.membersOf(o).accountActive(account),
        activeNames: (account) => RoomDO.membersOf(o).activeNames(account),
        setAccountLeft: (account, at) => RoomDO.membersOf(o).setAccountLeft(account, at),
        ofAccount: (account) => RoomDO.membersOf(o).ofAccount(account),
        drop: (names) => RoomDO.membersOf(o).drop(names),
        dropAccountComputers: (account) => RoomDO.membersOf(o).dropAccountComputers(account),
        carried: (owner, seat) => RoomDO.membersOf(o).carried(owner, seat),
        blockComputer: (name, owner, deviceId) => RoomDO.membersOf(o).blockComputer(name, owner, deviceId),
        dropSeat: (name) => RoomDO.membersOf(o).dropSeat(name),
        leaveCarried: (owner, seat, at) => RoomDO.membersOf(o).leaveCarried(owner, seat, at),
      },
      presence: { broadcastMembers: () => o.broadcastMembers() },
      messages: {
        system: (type, name) => o.systemMessage(type, name),
        dropAccountCache: (account) => RoomDO.messagesIn(o).dropAccountCache(account),
        dropAccountScreens: (account) => RoomDO.messagesIn(o).dropAccountScreens(account),
      },
      tasks: { release: (names, actor) => o.releaseItems(names, actor), yours: (name) => o.yours(name) },
      schedules: { dropAccount: (account) => o.dropAccountSchedules(account), stop: (reason) => o.stopSchedules(reason), dropAll: () => o.scheduler.dropAll() },
      handoffs: { dropSeats: (names) => o.handoffs.dropSeats(names) },
      quota: { forgetPlan: () => RoomDO.quotaOf(o).forgetPlan(), ownerLimits: () => o.ownerLimits() },
      approvals: { dropAccount: (account) => RoomDO.approvalsOf(o).dropAccount(account), dropHost: (name) => RoomDO.approvalsOf(o).dropHost(name) },
      snapshot: { drop: () => RoomDO.snapshotOf(o).dropIfWritten() },
    }));
  }

  // doSend runs on schedule-room's fake: every dep it calls reads the RoomDO name at call time, its own replaySend and
  // insertMessage included, so the fake's (and send-contract's countMessage, lifecycle-contract's ownerLimits) still
  // bite. Members' sendRows and takeoverChanged are new and go to Members directly.
  private static messagesIn(o: RoomDO): Messages {
    return (o._messages ??= new Messages({
      sql: () => o.sql,
      ctx: () => o.ctx,
      replaySend: (actor, nonce, echo) => o.replaySend(actor, nonce, echo),
      insertMessage: (p, attach) => o.insertMessage(p, attach),
      room: { require: () => o.room(), requireWritable: () => o.requireWritable(), info: () => o.roomInfo() },
      members: {
        require: (actor) => o.requireMember(actor),
        reader: (actor) => o.reader(actor),
        get: (name) => o.memberRow(name),
        touch: (name) => o.touch(name),
        takeoverFor: (name, owner) => o.takeoverFor(name, owner),
        currentHost: (name) => o.currentHost(name),
        all: (except) => o.allMembers(except),
        sendRows: () => RoomDO.membersOf(o).sendRows(),
        takeoverChanged: (account, roles) => RoomDO.membersOf(o).takeoverChanged(account, roles),
      },
      presence: { isOnline: (name, kind, except) => o.isOnline(name, kind, except), carriers: (name) => o.carriers(name), activity: (ts) => o.activity(ts) },
      memo: { steps: () => RoomDO.memoOf(o), state: () => RoomDO.memoOf(o).state() },
      tasks: {
        steps: () => RoomDO.tasksOf(o),
        todoFor: (rows, parents) => RoomDO.tasksOf(o).todoFor(rows, parents),
        todoOf: (seq) => o.todoOf(seq),
        todoState: () => o.todoState(),
        openCandidates: () => o.openCandidates(),
      },
      files: {
        withLinks: (files) => o.withLinks(files),
        sentFiles: (files) => o.sentFiles(files),
        attach: (seq, files) => RoomDO.filesOf(o).attach(seq, files),
        claim: (actor, ids) => o.claimFiles(actor, ids),
        consumeTicket: (label, expiresAt) => RoomDO.filesOf(o).consumeTicket(label, expiresAt),
      },
      quota: {
        ownerLimits: () => o.ownerLimits(),
        check: (lim) => o.checkQuota(lim),
        count: (lim, seq) => o.countMessage(lim, seq),
        markActive: () => o.markActive(),
        markSender: (kind, account) => o.markSender(kind, account),
      },
      snapshot: { publicChanged: () => o.publicChanged() },
    }));
  }

  // The export's reads (room/export.ts): every dep is another domain's function, none writes.
  private static exportOf(o: RoomDO): Export {
    return (o._export ??= new Export({
      room: { require: () => o.room(), info: () => o.roomInfo() },
      members: { require: (actor) => o.requireMember(actor), exportMembers: (actor) => RoomDO.membersOf(o).exportMembers(actor) },
      messages: {
        lastSeq: () => o.lastSeq(),
        exportCount: (upTo) => RoomDO.messagesIn(o).exportCount(upTo),
        exportRows: (from, upTo, limit) => RoomDO.messagesIn(o).exportRows(from, upTo, limit),
        of: (rows, viewer) => o.messagesOf(rows, viewer),
      },
      files: { exportFiles: (upTo) => RoomDO.filesOf(o).exportFiles(upTo) },
      tasks: { exportItems: () => RoomDO.tasksOf(o).exportItems() },
      schedules: { items: (actor) => o.scheduler.items(actor) },
      memo: { read: (actor, lang) => RoomDO.memoOf(o).read(actor, {}, lang) },
    }));
  }

  private static searchOf(o: RoomDO): Search {
    return (o._search ??= new Search({
      room: { require: () => o.room() },
      members: { reader: (actor) => o.reader(actor), get: (name) => o.memberRow(name) },
      messages: { search: (p) => RoomDO.messagesIn(o).search(p) },
      tasks: { searchItems: (p) => RoomDO.tasksOf(o).searchItems(p) },
      files: { searchFiles: (p) => RoomDO.filesOf(o).searchFiles(p) },
      memo: { search: (p) => RoomDO.memoOf(o).search(p) },
    }));
  }

  private get scheduler(): Schedules {
    return (this._scheduler ??= new Schedules({
      sql: () => this.sql,
      ctx: () => this.ctx,
      room: { require: () => this.room(), requireWritable: () => this.requireWritable() },
      members: {
        get: (name) => this.memberRow(name),
        require: (actor) => this.requireMember(actor),
        takeoverFor: (name, owner) => this.takeoverFor(name, owner),
        names: () => RoomDO.membersOf(this).names(),
      },
      messages: {
        insert: (m) => this.insertMessage(m),
        send: (actor, p, owner, scheduled) => this.doSend(actor, p, owner, scheduled),
      },
      quota: { ownerLimits: () => this.ownerLimits(), cachedPlan: () => RoomDO.quotaOf(this).cachedPlan() },
      alarm: { arm: () => this.armAlarm() },
      nonces: {
        replay: (sender, nonce) => this.replay(sender, nonce),
        remember: (sender, nonce, result) => this.remember(sender, nonce, result),
      },
    }));
  }

  private get timers(): Timers {
    return (this._timers ??= (() => {
      const timers = new Timers();
      timers.define("approvals:due", (t) => RoomDO.approvalsOf(this).alarm(t), () => RoomDO.approvalsOf(this).nextDue());
      timers.define("schedules:due", (t) => this.scheduler.alarm(t), () => this.scheduler.nextDue());
      timers.define("presence:roomFrame", (t) => RoomDO.presenceOf(this).alarm(t), () => RoomDO.presenceOf(this).nextDue());
      timers.define("files:sweep", (t) => RoomDO.filesOf(this).alarm(t), () => RoomDO.filesOf(this).nextDue());
      timers.define("tasks:items", (t) => RoomDO.tasksOf(this).alarm(t), () => RoomDO.tasksOf(this).nextDue());
      timers.define("memo:frame", (t) => RoomDO.memoOf(this).alarm(t), () => RoomDO.memoOf(this).nextDue());
      timers.define("snapshot:public", (t) => RoomDO.snapshotOf(this).alarm(t), () => RoomDO.snapshotOf(this).nextDue());
      timers.define("room:passcodes", (t) => RoomDO.roomOf(this).alarm(t), () => RoomDO.roomOf(this).nextDue());
      return timers;
    })());
  }

  // ---------- constructor ----------

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.handoffs = new Handoffs({
      sql: () => this.sql,
      publicUrl: () => this.env.PUBLIC_URL || "",
      room: { require: () => this.room(), requireWritable: () => this.requireWritable(), info: () => this.roomInfo() },
      members: {
        get: (name) => this.memberRow(name),
        reader: (actor) => this.reader(actor),
        require: (actor) => this.requireMember(actor),
        broadcast: () => this.broadcastMembers(),
        ofAccount: (account) => RoomDO.membersOf(this).ofAccount(account),
      },
    });
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      RoomDO.approvalsOf(this).wake();
      await RoomDO.roomOf(this).wake();
      await RoomDO.snapshotOf(this).wake();
    });
    // Keep-alive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- migrate ----------

  private migrate() {
    Room.createTable(this.sql);
    this.sql.exec(`
      -- Client idempotency keys for send/join (docs/api/README.md): same (sender, nonce) within 10 minutes returns the first result.
      CREATE TABLE IF NOT EXISTS nonces (sender TEXT NOT NULL, nonce TEXT NOT NULL, result TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (sender, nonce));
    `);
    Messages.createTables(this.sql);
    Memos.migrate(this.sql);
    Handoffs.migrate(this.sql);
    Approvals.migrate(this.sql);
    Schedules.migrate(this.sql);
    Tasks.migrate(this.sql);
    Tasks.createSearchView(this.sql);
    Members.migrate(this.sql);
    Room.migrate(this.sql);
    Messages.addScheduledAndFiles(this.sql);
    Messages.createThreadView(this.sql);
    Files.migrate(this.sql);
    Messages.addNonceAndTriggers(this.sql);
    Messages.backfillIndexes(this.sql, this.ctx.storage.kv);
    // Items from before threads get theirs once. A failure must not keep the room from starting.
    if (!this.ctx.storage.kv.get("itemThreadV1")) {
      try {
        RoomDO.tasksOf(this).backfillThreads();
        this.ctx.storage.kv.put("itemThreadV1", true);
      } catch (e) {
        console.error(JSON.stringify({ msg: "thread backfill failed", error: String(e) }));
      }
    }
    Messages.createFilesView(this.sql);
    // Published by members (read-only; readers: files listFiles and searchFiles, messages search, tasks searchItems).
    // Never written through.
    this.sql.exec("CREATE VIEW IF NOT EXISTS member_names_v AS SELECT name, kind, display_name FROM members");
  }

  // ---------- the alarm ----------

  async alarm() {
    const t = now() + 50;
    await this.timers.run(t);
    const next = this.nextDue();
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  /** One alarm per object: tasks are due times in storage, the alarm fires for the earliest. */
  private async schedule(task: string, delayMs: number) {
    if (this.ctx.storage.kv.get(task)) return;
    this.ctx.storage.kv.put(task, now() + delayMs);
    await this.armAlarm();
  }

  /** The earliest due time of everything the alarm runs; Infinity when nothing is due. */
  private nextDue(): number {
    return this.timers.next();
  }

  /**
   * Bring the alarm forward to the earliest due time. The target is read before the await: one event can arm twice
   * (a public topic's send arms its todo frame at 1 s and its snapshot at 10 s), both calls read the alarm before
   * either sets it, and the later write wins, so each must write the earliest time, not its own.
   */
  private async armAlarm() {
    const target = this.nextDue();
    if (target === Infinity) return;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > target) await this.ctx.storage.setAlarm(target);
  }

  // ---------- live connections ----------

  /** WebSocket upgrade; the Worker has authenticated the caller and passes it in X-Scorpio-Actor. */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/workspace") return RoomDO.workspaceOf(this).fetch(request);
    return RoomDO.presenceOf(this).fetch(request);
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (RoomDO.workspaceOf(this).message(ws, message)) return;
    return RoomDO.presenceOf(this).webSocketMessage(ws, message);
  }
  async webSocketClose(ws: WebSocket) {
    RoomDO.workspaceOf(this).disconnected(ws);
    if ((ws.deserializeAttachment() as { kind?: string } | null)?.kind !== "workspace") return RoomDO.presenceOf(this).webSocketClose(ws);
  }
  async webSocketError(ws: WebSocket) { return this.webSocketClose(ws); }

  async workspaceHosts(actor: Actor) { return this.wrap(() => ({ computers: RoomDO.workspaceOf(this).hosts(actor) })); }
  async workspaceSelection(actor: Actor, computerId?: string) { return this.wrap(() => {
    const { computer, topic } = RoomDO.workspaceOf(this).selected(actor, computerId);
    return { computer, topic };
  }); }
  async workspaceStart(actor: Actor, computerId: string, body: unknown) {
    try { return { ok: await RoomDO.workspaceOf(this).start(actor, computerId, body) }; }
    catch (error) { return this.wrap(() => { throw error; }); }
  }

  // ---------- RPCs, each forwarded to its domain ----------

  // The topic (room/room.ts).
  async init(p: { id: string; name: string; topic: string; owner: string; code: string | null }): Promise<RoomInfo> { return RoomDO.roomOf(this).init(p); }

  async info(): Promise<Result<RoomInfo>> { return RoomDO.roomOf(this).info(); }

  /** What D1's index should say about this room (the daily repair). Read only; deleted rooms too. */
  async indexState(): Promise<Result<IndexState>> { return RoomDO.roomOf(this).indexState(); }

  /** What the room page needs to decide between the room and the passcode form; displayName: what this room has for the person. */
  async peek(actor: Actor): Promise<Result<{ room: RoomInfo; member: boolean; displayName: string | null }>> { return RoomDO.roomOf(this).peek(actor); }

  async rotateCode(actor: Actor, code: string | null): Promise<Result<{ hasCode: boolean }>> { return RoomDO.roomOf(this).rotateCode(actor, code); }

  /**
   * Public: anyone signed in with the link enters, no passcode. Private: the passcode is asked for again;
   * a room that never had one gets `code` (made up by the Worker). Not a room message.
   */
  async setVisibility(actor: Actor, pub: boolean, code: string): Promise<Result<RoomInfo & { code: string | null }>> { return RoomDO.roomOf(this).setVisibility(actor, pub, code); }

  /** The owner's account (the person or one of their agents) changes the topic; not a room message. */
  async setTopic(actor: Actor, topic: string): Promise<Result<{ topic: string }>> { return RoomDO.roomOf(this).setTopic(actor, topic); }

  /** The owner's account renames the topic: a system line, and the new name in a room frame to pages and daemons. */
  async setName(actor: Actor, name: string): Promise<Result<{ name: string }>> { return RoomDO.roomOf(this).setName(actor, name); }

  /**
   * For the home page row of one person: the plan's numbers, agents working, who is in it, when it last
   * moved, and (when they are in it) what they have not read and what is addressed to them.
   */
  async summary(handle?: string): Promise<Result<RoomSummary>> { return RoomDO.roomOf(this).summary(handle); }

  /** The owner dissolves the room. Everyone connected is told and let go before its storage is purged. */
  async deleteRoom(actor: Actor): Promise<Result<{ roomId: string; deletedAt: number }>> { return RoomDO.roomOf(this).deleteRoom(actor); }

  /** R2 objects and all storage go; the Worker gives the space back by the index. */
  async purgeRoom(): Promise<Result<{ objects: number }>> { return RoomDO.roomOf(this).purgeRoom(); }

  // Members (room/members.ts).
  /** A person enters the room from the web (passcode unless owner or already a member), with their display name. */
  async enterHuman(actor: Actor, code?: string, displayName: string | null = null): Promise<Result<{ room: RoomInfo }>> { return RoomDO.membersOf(this).enterHuman(actor, code, displayName); }

  /** A person's display name changed: whether this room had a different one. */
  async setDisplayName(account: string, displayName: string | null): Promise<boolean> { return RoomDO.membersOf(this).setDisplayName(account, displayName); }

  async deviceChanged(account: string, deviceId: string, seat: string | null, oldSeat: string | null, device: { name: string; hostname: string; note: string | null }): Promise<Result<boolean>> {
    RoomDO.workspaceOf(this).hostChanged(account, deviceId);
    const result = await RoomDO.membersOf(this).deviceChanged(account, deviceId, seat, oldSeat, device);
    if ("ok" in result && result.ok) RoomDO.workspaceOf(this).hostChanged(account, deviceId);
    return result;
  }

  async loggedOutLine(account: string, deviceId: string, device: string): Promise<Result<boolean>> { return RoomDO.membersOf(this).loggedOutLine(account, deviceId, device); }

  /** Called with the seat name derived from this computer's authenticated device, never a caller supplied name. */
  async rejoinComputer(actor: Actor, name: string, deviceId = "", legacyName = name): Promise<Result<{ roomId: string; name: string; rejoined: boolean }>> {
    return RoomDO.membersOf(this).rejoinComputer(actor, name, deviceId, legacyName);
  }

  async join(actor: Actor, p: Parameters<Members["join"]>[1]): Promise<Result<Record<string, unknown>>> { return RoomDO.membersOf(this).join(actor, p); }

  async mark(actor: Actor, upTo: number): Promise<Result<{ roomId: string; name: string; cursor: number }>> { return RoomDO.membersOf(this).mark(actor, upTo); }
  async members(actor: Actor, p?: import("./member-filters").MemberFilters): Promise<Result<{ roomId: string; members: Member[] }>> { return RoomDO.membersOf(this).members(actor, p); }
  async setRoleCard(actor: Actor, roleCard: string): Promise<Result<{ roomId: string; name: string; roleCard: string }>> { return RoomDO.membersOf(this).setRoleCard(actor, roleCard); }
  async setRoleCardFor(actor: Actor, target: string, roleCard: string): Promise<Result<{ roomId: string; name: string; roleCard: string; roleCardBy: string; roleCardAt: number }>> {
    return RoomDO.membersOf(this).setRoleCardFor(actor, target, roleCard);
  }

  async setLane(actor: Actor, lane: string | null): Promise<Result<LaneAnswer>> { return RoomDO.membersOf(this).setLane(actor, lane); }
  async setLaneFor(actor: Actor, target: string, lane: string | null): Promise<Result<LaneAnswer>> { return RoomDO.membersOf(this).setLaneFor(actor, target, lane); }

  /**
   * The overview (docs/api/topics.md "The overview"): one read of each owning domain (members, messages' window counts,
   * tasks' deliveries) and the pure overviewOf. Always the last 7 days. A member reads it; the page route lets a public
   * topic's viewer in through viewOverview.
   */
  async overview(actor: Actor): Promise<Result<Overview>> {
    return this.wrap(() => { this.requireMember(actor); return this.overviewFor(actor); });
  }

  /**
   * The overview for the page: a member, or a signed-in viewer of a public topic (reader), as the topic page lets them
   * in. A viewer is not a member, so it is not a node on the map (person: null).
   */
  async viewOverview(actor: Actor): Promise<Result<Overview>> {
    return this.wrap(() => { const m = this.reader(actor); return this.overviewFor(actor, !!m); });
  }

  private overviewFor(actor: Actor, member = true): Overview {
    const until = now();
    const since = until - OVERVIEW_WINDOW_MS;
    const { sent, mentions } = RoomDO.messagesIn(this).windowCounts(since);
    return overviewOf({
      roomId: this.roomInfo().id,
      members: this.allMembers(),
      sent,
      mentions,
      delivered: RoomDO.tasksOf(this).deliveredSince(since),
      since,
      until,
      person: member && actor.kind === "human" ? actor.name : null,
    });
  }

  // The lifecycle operations (room/lifecycle.ts).
  async removeAccount(actor: Actor, account: string): Promise<Result<{ roomId: string; account: string; removed: string[] }>> { return RoomDO.lifecycleOf(this).removeAccount(actor, account); }

  async removeOwnComputer(actor: Actor, name: string): Promise<Result<{ roomId: string; removed: string[]; left: string[] }>> { return RoomDO.lifecycleOf(this).removeOwnComputer(actor, name); }

  async leaveAccount(actor: Actor): Promise<Result<{ roomId: string; left: string[]; public: boolean }>> { return RoomDO.lifecycleOf(this).leaveAccount(actor); }

  async leave(actor: Actor): Promise<Result<{ roomId: string; name: string; status: string; accountActive: boolean; open: Brief[] }>> { return RoomDO.lifecycleOf(this).leave(actor); }

  async accountGone(account: string): Promise<{ removed: string[] }> { return RoomDO.lifecycleOf(this).accountGone(account); }
  async prunePasscodeFailures(): Promise<void> { return RoomDO.roomOf(this).wake(); }

  async setArchived(actor: Actor, archived: boolean): Promise<Result<RoomInfo & { code: string | null }>> { return RoomDO.lifecycleOf(this).setArchived(actor, archived); }

  async planArchive(archived: boolean, reason: string): Promise<boolean> { return RoomDO.lifecycleOf(this).planArchive(archived, reason); }

  async planChanged(): Promise<void> { return RoomDO.lifecycleOf(this).planLapsed(); }

  // The retention clock (room/retention.ts): the daily job asks, the room decides.
  /** Stage 1: quiet topics are archived for retention; the room owns the archive write. */
  async quietArchive(cutoff: number): Promise<Result<{ archivedAt: number | null; archivedReason: string | null; lastAt: number }>> {
    return RoomDO.retentionOf(this).quietArchive(cutoff);
  }

  /** Stage 2: old archives are marked inaccessible before permanent purge. */
  async retentionPurge(cutoff: number): Promise<Result<{ deletedAt: number | null }>> {
    return RoomDO.retentionOf(this).retentionPurge(cutoff);
  }

  // Messages (room/messages.ts; docs/api/messages.md).
  async messages(actor: Actor, p: import("./search").SearchFilters & { q?: string; limit?: number }): Promise<Result<{ roomId: string; messages: Message[] }>> { return RoomDO.messagesIn(this).messages(actor, p); }

  /** Messages before `before` for the web page's "earlier" button. */
  async history(actor: Actor, before: number, limit = 100): Promise<Result<{ messages: Message[] }>> { return RoomDO.messagesIn(this).history(actor, before, limit); }

  /** The target and one page on either side, so a search hit can jump without paging back from today. */
  async around(actor: Actor, seq: number): Promise<Result<{ roomId: string; messages: Message[] }>> { return RoomDO.messagesIn(this).around(actor, seq); }

  /** The web page's "@me" list: pages of 50 going back with before=, each marked unread past the cursor. */
  async mentions(actor: Actor, before: number, limit = 50, filters?: import("./search").SearchFilters): Promise<Result<Record<string, unknown>>> { return RoomDO.messagesIn(this).mentions(actor, before, limit, filters); }

  async message(actor: Actor, seq: number): Promise<Result<{ roomId: string; message: Message }>> { return RoomDO.messagesIn(this).message(actor, seq); }

  async card(actor: Actor, seq: number) { return RoomDO.messagesIn(this).card(actor, seq); }

  async consumeCardTicket(ticket: Ticket, label: string) { return RoomDO.messagesIn(this).consumeCardTicket(ticket, label); }

  async press(actor: Actor, seq: number, index: number) { return RoomDO.messagesIn(this).press(actor, seq, index); }

  async send(actor: Actor, p: SendOp): Promise<Result<Record<string, unknown>>> { return RoomDO.messagesIn(this).send(actor, p); }

  async listen(actor: Actor): Promise<Result<Record<string, unknown>>> { return RoomDO.messagesIn(this).listen(actor); }

  /** This room's senders per day since `sinceMs`, for filling activity_daily with what was said before it existed. */
  async activitySince(sinceMs: number): Promise<Result<{ day: string; kind: string; account: string }[]>> { return RoomDO.messagesIn(this).activitySince(sinceMs); }

  /** One private read per room for the signed-in person's data page. */
  async myData(actor: Actor, sinceMs: number): Promise<Result<RoomData>> { return RoomDO.messagesIn(this).myData(actor, sinceMs); }

  // Search (room/search.ts).
  /** Search the history this actor can read. Archived rooms remain searchable from inside the room. */
  async search(actor: Actor, p: SearchQuery): Promise<Result<SearchResults>> { return RoomDO.searchOf(this).search(actor, p); }

  // Export (room/export.ts; docs/api/export.md): reads only, for the Worker's zip (export.ts).
  async exportHead(actor: Actor, include: readonly ExportPart[], lang: import("./layout").Lang = "en"): Promise<Result<ExportHead>> { return RoomDO.exportOf(this).exportHead(actor, include, lang); }
  async exportMessages(actor: Actor, from: number, upTo: number, limit?: number): Promise<Result<{ messages: Message[] }>> { return RoomDO.exportOf(this).exportMessages(actor, from, upTo, limit); }

  async memoRead(actor: Actor, p: import("./memo-types").MemoQuery = {}, lang: import("./layout").Lang = "en") { return RoomDO.memoOf(this).read(actor, p, lang); }
  async memoWrite(actor: Actor, p: import("./memo-types").MemoOp, page = false, lang: import("./layout").Lang = "en") { return RoomDO.memoOf(this).write(actor, p, page, lang); }

  // Tasks (room/tasks.ts; docs/api/tasks.md).
  async todoList(actor: Actor, round?: number): Promise<Result<Record<string, unknown>>> { return RoomDO.tasksOf(this).todoList(actor, round); }
  async todoBrief(actor: Actor, p: { mine?: boolean; to?: string | null }): Promise<Result<Record<string, unknown>>> { return RoomDO.tasksOf(this).todoBrief(actor, p); }
  async todoShow(actor: Actor, id: string, full = false): Promise<Result<Record<string, unknown>>> { return RoomDO.tasksOf(this).todoShow(actor, id, full); }
  async todo(actor: Actor, p: TodoOp): Promise<Result<Record<string, unknown>>> { return RoomDO.tasksOf(this).todo(actor, p); }

  /** Of these items, the ones still open and under this person's name (for closing notifications that are not). */
  async openForMe(handle: string, ids: string[]): Promise<string[]> { return RoomDO.tasksOf(this).openForMe(handle, ids); }

  // Files (room/files.ts).
  async listFiles(actor: Actor, p: ListFilesQuery): Promise<Result<ListFilesResult>> { return RoomDO.filesOf(this).listFiles(actor, p); }

  async addFile(actor: Actor, meta: FileMeta & { hash: string; charged: number }): Promise<Result<FileMeta & { url: string }>> { return RoomDO.filesOf(this).addFile(actor, meta); }

  async evictFiles(account: string, ids: string[]): Promise<Result<{ gone: string[]; trashed: string[]; missing: string[]; shown: { name: string; size: number }[] }>> { return RoomDO.filesOf(this).evictFiles(account, ids); }
  async evictedLine(account: string, files: { name: string; size: number }[]): Promise<void> { return RoomDO.filesOf(this).evictedLine(account, files); }
  async fileIndex(): Promise<Result<{ id: string; uploadedBy: string; size: number; charged: number; ts: number; hash: string; name: string }[]>> { return RoomDO.filesOf(this).fileIndex(); }
  async viewFile(actor: Actor, id: string): Promise<Result<FileView>> { return RoomDO.filesOf(this).viewFile(actor, id); }
  async consumeViewTicket(ticket: Ticket, label: string): Promise<Result<boolean>> { return RoomDO.filesOf(this).consumeViewTicket(ticket, label); }
  async fileMeta(actor: Actor, id: string): Promise<Result<FileMeta & { hash: string }>> { return RoomDO.filesOf(this).fileMeta(actor, id); }

  // Scheduled messages (room/schedules.ts; docs/api/schedules.md).
  async schedules(actor: Actor, id?: string): Promise<Result<Record<string, unknown>>> { return this.scheduler.schedules(actor, id); }
  async scheduleOp(actor: Actor, p: ScheduleOp): Promise<Result<Record<string, unknown>>> { return this.scheduler.scheduleOp(actor, p); }
  /** Read-only, for the person's calendar feed (calendar-feed.ts): this topic's schedules marked for their calendar. */
  async calendarItems(handle: string): Promise<Result<CalendarTopic>> { return this.scheduler.calendarItems(handle); }

  async answerApproval(actor: Actor, id: string, body: Record<string, unknown>): Promise<ApprovalAnswerResult> {
    return RoomDO.approvalsOf(this).answer(actor, id, body);
  }

  // Presence (room/presence.ts).
  /** Of these agents, those of this account still stuck at a prompt (to close their agent_blocked notifications). */
  async blockedOf(handle: string, names: string[]): Promise<string[]> { return RoomDO.presenceOf(this).blockedOf(handle, names); }

  /** This account's list of rooms changed: tell its daemon seats connected here. Returns the seats told. */
  async roomsChanged(account: string, skip: string[]): Promise<string[]> { return RoomDO.presenceOf(this).roomsChanged(account, skip); }

  /** These agent tokens stopped working: their connections here close with 4011. Returns how many. */
  async closeTokens(tokenIds: string[], reason: string): Promise<number> { return RoomDO.presenceOf(this).closeTokens(tokenIds, reason); }

  // Handoffs in the cloud (room/handoffs.ts; docs/api/files.md).
  async handoffWriter(actor: Actor): Promise<Result<{ name: string }>> { return this.wrap(() => this.handoffs.writer(actor)); }
  async putHandoff(actor: Actor, p: { body: string; size: number; computer: string | null }): Promise<Result<Handoff & { link: string }>> { return this.wrap(() => this.handoffs.put(actor, p)); }
  async getHandoff(actor: Actor, name: string): Promise<Result<Handoff & { body: string }>> { return this.wrap(() => this.handoffs.get(actor, name)); }
  async viewHandoff(actor: Actor, name: string): Promise<Result<HandoffView>> { return this.wrap(() => this.handoffs.view(actor, name)); }
  async deleteHandoff(actor: Actor, name: string): Promise<Result<{ roomId: string; name: string; deleted: true }>> { return this.wrap(() => this.handoffs.delete(actor, name)); }

  // ---------- private forwards: the names the deps read over `o`, and that tests call or fake ----------

  // The technical layer (room/kernel.ts).
  private wrap<T>(fn: () => T): Result<T> { return wrap(fn); }
  /** Idempotent writes: a retried request with the same nonce gets the first answer back. */
  private replay(sender: string, nonce: string | undefined): Record<string, unknown> | null { return replay(this.sql, sender, nonce); }
  private remember<T>(sender: string, nonce: string | undefined, result: T): T { return remember(this.sql, sender, nonce, result); }
  private safeSend(ws: WebSocket, data: string) { return safeSend(ws, data); }

  // The topic.
  private room(): Row { return RoomDO.roomOf(this).require(); }
  /** The room's row, deleted or not (deleting, restoring and purging need it). */
  private roomRow(): Row { return RoomDO.roomOf(this).roomRow(); }
  private roomInfo(r?: Row): RoomInfo { return RoomDO.roomOf(this).roomInfo(r); }
  /** An archived room is read-only: what it holds stays, nothing new goes in. */
  private requireWritable() { RoomDO.roomOf(this).requireWritable(); }
  private requireOwner(actor: Actor, what: string): Row { return RoomDO.roomOf(this).requireOwner(actor, what); }
  private checkCode(r: Row, code: string | undefined, account: string) { RoomDO.roomOf(this).checkCode(r, code, account); }
  private isPublicRoom(): boolean { return RoomDO.roomOf(this).isPublicRoom(); }
  /** Room metadata for members' pages, passcode included (members may read it). */
  private memberRoomView() { return RoomDO.roomOf(this).memberRoomView(); }
  /** Room metadata changed: members' browsers get the room (passcode included), viewers' without it, daemons a room frame. */
  private broadcastRoom(hosts = false) { RoomDO.roomOf(this).broadcastRoom(hosts); }

  // Members.
  private memberRow(name: string): Row | undefined { return RoomDO.membersOf(this).memberRow(name); }
  private requireMember(actor: Actor): Row { return RoomDO.membersOf(this).requireMember(actor); }
  private reader(actor: Actor): Row | null { return RoomDO.membersOf(this).reader(actor); }
  private touch(name: string) { RoomDO.membersOf(this).touch(name); }
  private allMembers(except?: WebSocket): Member[] { return RoomDO.membersOf(this).allMembers(except); }
  private takeoverFor(name: string, owner: string): { command: string; seq: number } | null { return RoomDO.membersOf(this).takeoverFor(name, owner); }
  private currentHost(name: string): string | null { return RoomDO.membersOf(this).currentHost(name); }
  private renameHost(oldName: string, newName: string, deviceId: string, device: { name: string; hostname: string; note: string | null }): boolean {
    return RoomDO.membersOf(this).renameHost(oldName, newName, deviceId, device);
  }

  // Presence.
  private isViewer(ws: WebSocket): boolean { return RoomDO.presenceOf(this).isViewer(ws); }
  private isOnline(name: string, kind: string, except?: WebSocket): boolean { return RoomDO.presenceOf(this).isOnline(name, kind, except); }
  private carriers(name: string): WebSocket[] { return RoomDO.presenceOf(this).carriers(name); }
  private workOf(r: Row, except?: WebSocket): string | null { return RoomDO.presenceOf(this).workOf(r, except); }
  private activity(ts: number) { RoomDO.presenceOf(this).activity(ts); }
  private broadcastMembers(except?: WebSocket, presence = false) { RoomDO.presenceOf(this).broadcastMembers(except, presence); }

  // Messages.
  private lastSeq(): number { return RoomDO.messagesIn(this).lastSeq(); }
  /** Messages' reads behind members' takeover lookups (takeoverFor, currentHost). */
  private takeoverCandidates(owner: string, role: string, afterSeq = 0): Row[] { return RoomDO.messagesIn(this).takeoverCandidates(owner, role, afterSeq); }
  private renamedEvents(): Row[] { return RoomDO.messagesIn(this).renamedEvents(); }
  /** Resolve a page's reply quotes and task links in two queries, regardless of page length. */
  private messagesOf(rows: Row[], viewer?: Actor): Message[] { return RoomDO.messagesIn(this).messagesOf(rows, viewer); }
  private envelope(m: Message) { return RoomDO.messagesIn(this).envelope(m); }
  /** Unmarked messages that wake this agent, oldest first. */
  private pending(name: string, cursor: number): Message[] { return RoomDO.messagesIn(this).pending(name, cursor); }
  /** Messages addressed to me past my cursor: a scan from the cursor on, not of the whole room. */
  private mentionUnread(name: string, cursor: number): number { return RoomDO.messagesIn(this).mentionUnread(name, cursor); }
  /** A send retried with the same nonce within 10 minutes: the first answer again, from the message itself. */
  private replaySend(actor: Actor, nonce: string | undefined, echo = false): Record<string, unknown> | null { return RoomDO.messagesIn(this).replaySend(actor, nonce, echo); }
  /** Write a message and fan it out; the single write path for people, agents and the system. */
  private insertMessage(p: NewMessage, attach?: (seq: number) => void): Message { return RoomDO.messagesIn(this).insertMessage(p, attach); }
  /** The one write path for a member's message; throws ApiError. */
  private doSend(actor: Actor, p: SendOp, owner: { plan: Plan; limits: Limits }, scheduled?: NonNullable<Message["scheduled"]>): Record<string, unknown> {
    return RoomDO.messagesIn(this).doSend(actor, p, owner, scheduled);
  }
  private systemMessage(type: "join" | "leave", name: string) { RoomDO.messagesIn(this).systemMessage(type, name); }
  /** A file's entry in its message: deleted (ms) once it went (or previously removed). Pages are told at once. */
  private markFileInMessage(seq: number, id: string, deleted: number | null) { RoomDO.messagesIn(this).markFileInMessage(seq, id, deleted); }
  /** Messages written after `ts` that count (people, agents, daemons; not system lines), and when the first was. */
  private countSince(ts: number, afterSeq = 0): { n: number; first: number | null } { return RoomDO.messagesIn(this).countSince(ts, afterSeq); }
  /** When the last counted message was written (people, agents, daemons; not system lines), else when the room was made. */
  private lastCountedAt(r: Row): number { return RoomDO.messagesIn(this).lastCountedAt(r); }

  // Files.
  private withLinks<T extends FileMeta>(files: T[]): (T & { link: string; view: boolean })[] { return RoomDO.filesOf(this).withLinks(files); }
  private sentFiles(files: FileMeta[]): { files?: { id: string; name: string; size: number; link: string }[] } { return RoomDO.filesOf(this).sentFiles(files); }
  private claimFiles(actor: Actor, ids: string[]): (FileMeta & { url: string })[] { return RoomDO.filesOf(this).claimFiles(actor, ids); }

  // Tasks.
  /** The open items, as joins() needs them. */
  private openCandidates(): OpenItem[] { return RoomDO.tasksOf(this).openCandidates(); }
  /** The TODO items a message carries, as they are now: the threads it is in, and how it joined each. */
  private todoOf(seq: number): { todo?: Message["todo"] } { return RoomDO.tasksOf(this).todoOf(seq); }
  private counts(): Counts { return RoomDO.tasksOf(this).counts(); }
  private todoState() { return RoomDO.tasksOf(this).todoState(); }
  /** What is still open under this name (done answers, join and leave; CLI 0.5.3). */
  private yours(name: string): Brief[] { return RoomDO.tasksOf(this).yours(name); }
  private openItems(): Item[] { return RoomDO.tasksOf(this).openItems(); }
  private todoFrame(): string { return RoomDO.tasksOf(this).todoFrame(); }
  /** Nobody who left is on anything: doing items under these names go back to todo. */
  private releaseItems(names: string[], actor: Pick<Actor, "name">) { RoomDO.tasksOf(this).releaseItems(names, actor); }

  // Scheduled messages.
  private stopSchedules(reason: "archived" | "pro_expired") { this.scheduler.stopSchedules(reason); }
  private dropAccountSchedules(account: string) { this.scheduler.dropAccountSchedules(account); }
  private scheduleText(text: unknown, actor: Actor): { text: string; to: string[] } { return this.scheduler.scheduleText(text, actor); }
  private async fire(row: Row, at: number) { await this.scheduler.fire(row, at); }

  // The message quota: per minute, per day, per owner account.
  /** The room owner's plan and its limits, kept in storage so a waking room does not ask D1 each time. */
  private async ownerLimits(): Promise<{ plan: Plan; limits: Limits }> { return RoomDO.quotaOf(this).ownerLimits(); }
  private messagesToday(): number { return RoomDO.quotaOf(this).messagesToday(); }
  private checkQuota(lim: Limits) { return RoomDO.quotaOf(this).checkQuota(lim); }
  private countMessage(lim: Limits, seq: number): { used: number; limit: number; resetsAt: number } | undefined { return RoomDO.quotaOf(this).countMessage(lim, seq); }
  private markActive() { RoomDO.quotaOf(this).markActive(); }
  private markSender(kind: string, account: string) { RoomDO.quotaOf(this).markSender(kind, account); }
  private quotaView(plan: Plan, lim: Limits) { return RoomDO.quotaOf(this).quotaView(plan, lim); }

  // The snapshot of a public room for visitors who are not signed in.
  /** Something a snapshot shows changed: rewrite it within 10 s (coalesced), or drop it once the room is not public. */
  private publicChanged() { RoomDO.snapshotOf(this).publicChanged(); }
  /** KV public:<roomId>: name, topic, archived, the last seq, and the last N messages as written (N = config:public_snapshot, 10). */
  private async writeSnapshot() { await RoomDO.snapshotOf(this).writeSnapshot(); }

  // The lifecycle operations.
  private markDeleted(why: { by: string } | { reason: "retention" }): number { return RoomDO.lifecycleOf(this).markDeleted(why); }
}
