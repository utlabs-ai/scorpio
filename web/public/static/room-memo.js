(function () {
  "use strict";
  function number(id) { return Number(String(id).slice(1)); }
  function evictionPick(short) {
    var older = short.filter(function (m) { return m.rounds > 0; });
    return (older.length ? older : short).slice().sort(function (a, b) {
      return a.score - b.score || a.lastUsedMs - b.lastUsedMs || number(a.id) - number(b.id);
    })[0] || null;
  }
  window.scorpioMemoEviction = evictionPick;

  window.createRoomMemo = function (ctx) {
    var S = ctx.S.memo, rootS = ctx.S, esc = escapeHtml, fill = ctx.fill;
    var sheet = ctx.$("memo-sheet"), scrim = ctx.$("memo-scrim"), current = null, generation = 0;
    var mode = "", form = null, list = [], listSlot = null, more = false, listGen = 0, busy = false, error = "";
    var X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    function time(ms) { return ms == null ? "" : ctx.fmtTime(ms); }
    function named(name) { return name ? ctx.nameText(name) : ""; }
    function shown(name, kind) { return name ? ctx.rowName(name, kind) : ""; }
    function sourceLine(from, by, kind) {
      return fill(esc(S.sourceBy), {from:button('source',from,' data-mm-source="'+esc(from)+'"','mm-src'),by:shown(by,kind)});
    }
    function short(id) { return current && current.short.find(function (m) { return m.id === id; }); }
    function long(slot) { return current && current.long.find(function (l) { return l.slot === slot; }); }
    function readOnly() { return ctx.viewer ? S.viewer : S.archived; }
    function button(act, label, attrs, cls) { return '<button type="button" class="' + (cls || 'mm-k') + '" data-mm-act="' + act + '"' + (attrs || '') + '>' + esc(label) + '</button>'; }
    function help(withTitle) { return (withTitle ? '<h3 class="mh-t">' + esc(S.helpTitle) + '</h3>' : '') + '<ul class="mh-list">' + S.help.map(function (line) { return '<li>' + esc(line) + '</li>'; }).join('') + '</ul>'; }
    function longCard(l) {
      var meta = l.version ? fill(esc(S.longVersion), { version: l.version, by: shown(l.by,l.byKind), time: esc(time(l.ms)) }) : '';
      return '<section class="ml" id="mm-' + l.slot + '"><div class="ml-h"><b>' + l.slot + '</b><span class="ml-v">' + meta + '</span><span class="sp"></span>' + (l.version ? button('history', S.history, ' data-mm-slot="' + l.slot + '"') : '') + '</div>' +
        '<button type="button" class="ml-body" data-mm-act="long" data-mm-slot="' + l.slot + '" aria-label="' + esc(ctx.canWrite() ? fill(S.editLong, {slot:l.slot}) : l.slot) + '"><span class="ml-t' + (l.text ? '' : ' mm-none') + '">' + esc(l.text || S.longEmpty) + '</span></button></section>';
    }
    function card(m) {
      var attrs = ' data-mm-id="' + esc(m.id) + '"', write = ctx.canWrite();
      var votes = m.votes || {good:[],bad:[]};
      function vote(kind) { var on = votes[kind].indexOf(ctx.state.me) >= 0; return '<button type="button" class="mm-v' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-mm-act="vote" data-mm-vote="' + kind + '"' + attrs + '>' + esc(S[kind]) + '</button>'; }
      return '<article class="mm' + (m.promotable ? ' merge' : '') + '" id="mm-' + esc(m.id) + '"><div class="mm-top"><b class="mm-id">' + esc(m.id) + '</b><span class="mm-who">' + ctx.avatar({from:m.by,fromKind:m.byKind}) + '<b>' + ctx.rowName(m.by,m.byKind) + '</b><span class="mm-kind">' + esc(m.byKind === 'human' ? S.human : S.agent) + '</span></span>' +
        button('source', m.from, ' data-mm-source="' + esc(m.from) + '"', 'mm-src') + (m.promotable ? '<span class="mm-flag">' + esc(S.toMerge) + '</span>' : '') + (m.misled ? '<span class="mm-bad">' + esc(fill(S.misled,{n:m.misled})) + '</span>' : '') + '</div><p class="mm-t">' + esc(m.text) + '</p><div class="mm-act"><span class="mm-score' + (write ? '' : ' mm-ro') + '">' +
        (write ? vote('good') : '') + button('show',fill(S.score,{score:m.score}),attrs,'mm-n') + (write ? vote('bad') : '') + '</span><span class="sp"></span>' +
        (write && m.promotable ? '<span class="mm-merge"><span>' + esc(S.mergeWord) + '</span>' + ['L1','L2'].map(function (slot) { return button('merge',slot,attrs+' data-mm-slot="'+slot+'"'); }).join('') + '</span>' : '') +
        (write ? button('replace', S.edit, attrs) + button('retire', S.retire, attrs) : '') + '</div></article>';
    }
    function html() {
      var head = '<div class="fixed mm-head"><span class="mm-sum">' + esc(current ? fill(S.summary,{n:current.short.length}) : rootS.searchLoading) + '</span>' + button('help','?',' aria-label="'+esc(S.helpLabel)+'"','mm-q') + '<span class="sp"></span>' + (ctx.canWrite() ? button('new',S.write,'','btn sm line') : '') + '</div>';
      if (!current) return head + '<div class="scroll mm-scroll"><p class="mm-note">' + esc(error || rootS.searchLoading) + '</p></div>';
      var empty = !current.short.length && !current.retired && !current.long.some(function (l) { return l.version; });
      return head + '<div class="scroll mm-scroll">' + (!ctx.canWrite() ? '<p class="mm-note">' + esc(readOnly()) + '</p>' : '') +
        (empty ? help(true) : current.long.map(longCard).join('') + '<div class="grp">' + esc(S.shortHeading) + '</div>' + (current.pending.length ? '<p class="mm-pending">' + esc(fill(S.pending,{ids:current.pending.join(' ')})) + '</p>' : '') +
        current.short.slice().sort(function (a,b) { return b.score-a.score || number(a.id)-number(b.id); }).map(card).join('') +
        (current.retired ? '<button type="button" class="grp grp-fold mm-retired" data-mm-act="retired">'+esc(fill(S.retired,{n:current.retired}))+'<span class="chev" aria-hidden="true">›</span></button>' : '')) + '<div class="mm-end"></div></div>';
    }
    function visible() { return ctx.panels.isOpen() && ctx.panels.kind() === 'memo' || ctx.panels.sideOpen() && ctx.panels.sideView() === 'memo'; }
    function refresh() {
      if (form) updateEditorFoot();
      if (visible()) { if (ctx.panels.sideOpen() && ctx.panels.sideView() === 'memo') ctx.panels.renderSide(); if (ctx.panels.isOpen() && ctx.panels.kind() === 'memo') ctx.openPanel('memo'); }
    }
    function get(params) {
      return fetch('/r/' + ctx.boot.roomId + '/memo' + (params ? '?' + new URLSearchParams(params) : ''), {credentials:'same-origin',headers:{accept:'application/json'}})
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw j; return j; }); });
    }
    function frame(value) {
      if (!value) return;
      var next = {nextId:value.nextId,long:value.long || [],short:value.short || [],retired:value.retired || 0,pending:value.pending || [],round:value.round || 0,cites:value.cites || 0,logLast:value.logLast == null ? current && current.logLast || 0 : value.logLast};
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      generation++; current = next; if (mode !== 'editor') error = ''; refresh(); if (mode === 'retired' || mode === 'history') viewList(mode,listSlot,true);
    }
    function load() {
      var gen = generation;
      return get().then(function (j) { if (gen === generation) frame(j); }, function (e) { if (gen === generation) { error = e.next || rootS.searchError; refresh(); } });
    }
    function close() { mode = ''; form = null; listGen++; sheet.classList.add('hidden'); scrim.classList.add('hidden'); sheet.innerHTML = ''; }
    function showSheet(title, body) {
      var parts = title.split(' · '), mainTitle = parts.shift(), sub = parts.length ? '<span class="mmed-sub"> · '+esc(parts.join(' · '))+'</span>' : '';
      sheet.innerHTML = '<div class="grab"></div><header class="sh"><b class="mmed-t">' + esc(mainTitle) + '</b>'+sub+'<span class="sp"></span>' + button('close','', ' aria-label="'+esc(rootS.cancel)+'"','x') + '</header><div class="sbody">' + body + '</div>';
      var x = sheet.querySelector('[data-mm-act="close"]'); if (x) x.innerHTML = X;
      sheet.classList.remove('hidden'); scrim.classList.remove('hidden');
    }
    function source(from) {
      if (/^#\d+$/.test(from)) { if (window.matchMedia('(max-width: 760px)').matches) ctx.closePanel(); close(); ctx.jumpTo(Number(from.slice(1))); }
      else if (/^T\d+$/.test(from)) { close(); ctx.openItem(from); }
    }
    function selectedMerged(ids) {
      return (ids || []).map(function (id) { return short(id); }).filter(Boolean);
    }
    function editShort(message, replacement) {
      if (!ctx.canWrite()) return;
      if (!current || !current.nextId) { ctx.openPanel('memo'); return load(); }
      form = {long:false,title:replacement ? fill(S.replaceTitle,{id:replacement.id}) : message ? S.saveMessage : S.write,
        text:replacement ? replacement.text : message ? String(message.text || '').replace(/^(\s*@[A-Za-z0-9_.@-]+)*\s*/, '') : '',
        from:replacement ? replacement.from : message ? '#'+message.seq : '', fromMessage:!!message,
        by:message ? message.from : ctx.state.me, byKind:message ? message.fromKind : 'human', replaces:replacement ? replacement.id : null};
      mode = 'editor'; error = ''; drawEditor();
    }
    function editLong(slot, ids) {
      var l = long(slot) || {slot:slot,version:0,text:''};
      if (!ctx.canWrite()) { mode = 'detail'; showSheet(slot,'<p class="ml-read">'+esc(l.text)+'</p>'); return; }
      var merged = selectedMerged(ids);
      var tail = merged.map(function (m) { return m.text.replace(/[。.]\s*$/, '') + (ctx.boot.lang === 'zh' ? '（'+m.id+'，'+named(m.by)+'，'+m.from+'）。' : ' ('+m.id+', '+named(m.by)+', '+m.from+').'); }).join('\n');
      form = {long:true,slot:slot,version:l.version,text:l.text+(tail ? (l.text ? '\n\n' : '')+tail : ''),merged:merged.map(function (m) { return m.id; })};
      mode = 'editor'; error = ''; drawEditor();
      var input = sheet.querySelector('[data-mm-text]'); if (input && merged.length) input.scrollTop = input.scrollHeight;
    }
    function editorNote() {
      if (!ctx.canWrite()) return readOnly();
      if (form.long) return form.merged.length ? fill(S.mergeHint,{ids:form.merged.join(' '),slot:form.slot}) : '';
      if (form.replaces) return fill(S.replaceHint,{id:form.replaces});
      var evicted = current && current.short.length >= 8 && evictionPick(current.short);
      return evicted ? fill(S.fullHint,{id:evicted.id,score:evicted.score}) : '';
    }
    function updateEditorFoot() {
      if (!form || mode !== 'editor') return;
      var count = Array.from(form.text).length, max = form.long ? 3500 : 500;
      var counter = sheet.querySelector('[data-mm-count]'), note = sheet.querySelector('[data-mm-note]'), err = sheet.querySelector('[data-mm-error]'), save = sheet.querySelector('[data-mm-save]');
      if (counter) counter.textContent = count+' / '+max;
      if (note) note.textContent = editorNote();
      if (err) err.innerHTML = count > max ? esc(fill(S.tooLong,{max:max,n:count})) : error && error.html || esc(error);
      var input = sheet.querySelector('[data-mm-text]'); if (input) input.readOnly = busy || !ctx.canWrite();
      var sourceInput = sheet.querySelector('[data-mm-from]'); if (sourceInput) sourceInput.disabled = busy || !ctx.canWrite();
      if (save) { save.textContent = form.long ? fill(S.saveVersion,{n:form.version+1}) : fill(S.saveShort,{id:current && current.nextId || ''}); save.disabled = busy || !ctx.canWrite() || !form.long && !(current && current.nextId) || count > max || !form.long && !form.text.trim(); save.hidden = !ctx.canWrite(); }
    }
    function drawEditor() {
      var title = form.long ? fill(form.merged.length ? S.mergeLong : S.editLong,{slot:form.slot,ids:form.merged.join(' ')}) : form.title;
      var source = form.long ? esc(fill(S.editing,{n:form.version})) : form.fromMessage ? sourceLine(form.from,form.by,form.byKind) : '';
      var save = form.long ? fill(S.saveVersion,{n:form.version+1}) : fill(S.saveShort,{id:current && current.nextId || ''});
      showSheet(title,'<div class="topicedit mmed-ed"><textarea class="'+(form.long ? 'tall' : '')+'" data-mm-text aria-label="'+esc(title)+'">'+esc(form.text)+'</textarea><div class="topicfoot"><small>'+source+'</small><span class="sp"></span><small data-mm-count></small></div></div>'+(!form.long && !form.fromMessage ? '<label class="mmed-from"><span>'+esc(S.source)+'</span><input data-mm-from type="text" value="'+esc(form.from || '')+'" placeholder="'+esc(S.sourcePlaceholder)+'"></label>' : '')+'<p class="mmed-note" data-mm-note></p><p class="mm-error" data-mm-error role="status"></p><div class="mmed-btns">'+button('close',rootS.cancel,'','btn')+button('save',save,' data-mm-save','btn primary')+'</div>');
      updateEditorFoot();
    }
    function write(body) {
      if (!ctx.canWrite() || busy) return Promise.resolve(null);
      var sentForm = form, sentMode = mode;
      busy = true; if (mode !== 'editor') error = ''; updateEditorFoot();
      return ctx.post('memo',Object.assign({nonce:crypto.randomUUID()},body)).then(function (r) {
        busy = false; updateEditorFoot();
        if (mode === 'editor' && form === sentForm) { close(); ctx.openPanel('memo'); }
        return load().then(function () { return r; });
      },function (e) {
        busy = false; updateEditorFoot();
        if (mode !== sentMode || form !== sentForm) { ctx.flash(e.next || rootS.searchError); return null; }
        if (e.error === 'version_conflict' && form && form.long && e.current) {
          form.version = e.current.version; form.text = e.current.text;
          error = {html:fill(esc(S.conflict),{slot:esc(form.slot),version:String(e.current.version),by:shown(e.current.by,e.current.byKind),time:esc(time(e.current.ms))})};
          drawEditor();
        } else {
          error = e.next || rootS.searchError;
          if (mode === 'editor') updateEditorFoot(); else if (mode === 'retired' || mode === 'history') drawList();
          else if (mode) showSheet(S.tab,'<p class="mm-error" role="status">'+esc(error)+'</p>');
          else ctx.flash(error);
        }
        return null;
      });
    }
    function save() {
      if (!form || !ctx.canWrite()) return;
      if (Array.from(form.text).length > (form.long ? 3500 : 500)) return updateEditorFoot();
      if (form.long) {
        var missing = form.merged.filter(function (id) { return !new RegExp('\\b'+id+'\\b').test(form.text); });
        if (missing.length) { error = fill(S.mergeMissing,{ids:missing.join(' ')}); return updateEditorFoot(); }
        return write({op:'long',slot:form.slot,version:form.version,text:form.text,merged:form.merged});
      }
      if (!form.text.trim()) return updateEditorFoot();
      var from = String(form.from || '').trim();
      if (!/^(?:#[1-9]\d*|T[1-9]\d*)$/.test(from)) { error = S.sourcePlaceholder; return updateEditorFoot(); }
      return write(Object.assign({op:'add',text:form.text,from:from},form.replaces ? {replaces:form.replaces} : {}));
    }
    var listLoading = false;
    function viewList(kind, slot, fresh) {
      if (!fresh && (listLoading || !more)) return;
      mode = kind; listSlot = slot || null;
      var params = kind === 'retired' ? {retired:'1',limit:'20'} : {versions:slot,limit:'20'};
      var gen = ++listGen;
      if (fresh) { list = []; more = false; error = ''; }
      else if (list.length) params.before = kind === 'retired' ? list[list.length-1].id : list[list.length-1].version;
      listLoading = true; drawList();
      return get(params).then(function (j) {
        if (gen !== listGen) return;
        list = list.concat(kind === 'retired' ? j.memos || [] : j.versions || []).slice(0,kind === 'retired' ? 50 : 10);
        more = !!j.hasMore; listLoading = false; error = ''; drawList();
      },function (e) { if (gen === listGen) { listLoading = false; error = e.next || rootS.searchError; drawList(); } });
    }
    function versionExtra(v) {
      if ((v.merged || []).length) return fill(S.versionMerged,{ids:v.merged.join(' ')});
      if (!v.big) return '';
      return [v.shorter ? fill(S.versionShorter,{n:v.shorter}) : '', (v.lost || []).length ? fill(S.versionLost,{ids:v.lost.join(' ')}) : ''].filter(Boolean).join(ctx.boot.lang === 'zh' ? '，' : ', ');
    }
    function drawList() {
      if (mode !== 'retired' && mode !== 'history') return;
      var title = mode === 'retired' ? fill(S.retired,{n:current ? current.retired : list.length}) : fill(S.historyTitle,{slot:listSlot,n:long(listSlot) ? long(listSlot).version : 0});
      var evicted = current && current.short.length >= 8 && evictionPick(current.short);
      var note = mode === 'history' ? S.restoreNote : evicted ? fill(S.retiredNote,{id:evicted.id}) : S.retiredKeep;
      var rows = list.map(function (m) {
        if (mode === 'retired') {
          var tag = m.state === 'replaced' ? fill(S.replaced,{to:m.leftTo}) : m.state === 'merged' ? fill(S.merged,{slot:String(m.leftTo).split(' ')[0]}) : S.evicted;
          return '<li class="mr"><button type="button" class="mr-l" data-mm-act="show" data-mm-id="'+esc(m.id)+'"><b class="mm-id">'+esc(m.id)+'</b><span class="mr-t">'+esc(m.text)+'</span></button><div class="mr-m"><span class="mr-tag">'+esc(tag)+'</span><span class="mr-s">'+esc(fill(S.wasScore,{score:m.score}))+'</span><span class="sp"></span>'+(ctx.canWrite() ? button('restore',S.restore,' data-mm-id="'+esc(m.id)+'"','btn sm line') : '')+'</div></li>';
        }
        var extra = versionExtra(m), isCurrent = long(listSlot) && long(listSlot).version === m.version;
        var action = isCurrent ? '<span class="mv-cur">'+esc(S.current)+'</span>' : ctx.canWrite() ? button('restore-version',S.restoreVersion,' data-mm-version="'+m.version+'" data-mm-slot="'+listSlot+'"','btn sm line') : '';
        return '<li class="mr"><div class="mr-l"><b class="mv-v">'+esc(fill(S.version,{n:m.version}))+'</b><span class="mr-t mv-who">'+shown(m.by,m.byKind)+' · '+esc(time(m.ms))+'</span>'+(m.big ? '<span class="mm-flag">'+esc(S.big)+'</span>' : '')+(extra ? '' : '<span class="sp"></span>'+action)+'</div>'+(extra ? '<div class="mr-m"><span class="mr-s">'+esc(extra)+'</span><span class="sp"></span>'+action+'</div>' : '')+'</li>';
      }).join('');
      showSheet(title,'<p class="mmed-note mr-note">'+esc(note)+'</p><ul class="mr-list">'+rows+'</ul>'+(listLoading ? '<p class="mm-note">'+esc(rootS.searchLoading)+'</p>' : '')+(error ? '<p class="mm-error" role="status">'+esc(error)+'</p>' : '')+(more && !listLoading ? button('more',rootS.searchMore,'','btn line') : ''));
    }
    function show(id) {
      ctx.openPanel('memo');
      var active = short(id);
      if (/^L[12]$/.test(id)) { editLong(id,[]); return Promise.resolve(); }
      if (active) {
        var card = ctx.$('mm-'+id);
        if (card && card.scrollIntoView) { card.scrollIntoView({block:'center'}); card.classList.add('fresh'); setTimeout(function () { card.classList.remove('fresh'); },600); }
      }
      var gen = ++listGen; mode = 'detail'; showSheet(id,'<p class="mm-note">'+esc(rootS.searchLoading)+'</p>');
      return get({show:id}).then(function (j) { if (gen !== listGen) return; var m = j.memo; showSheet(m.id,'<p class="ml-read">'+esc(m.text)+'</p><p class="mmed-note">'+sourceLine(m.from,m.by,m.byKind)+'</p>'+(m.state && ctx.canWrite() ? button('restore',S.restore,' data-mm-id="'+esc(m.id)+'"','btn line') : '')); },function (e) { if (gen === listGen) showSheet(id,'<p class="mm-error" role="status">'+esc(e.next || rootS.searchError)+'</p>'); });
    }
    function messageTags(m) {
      if (!m.memo) return '';
      return '<div class="mtags">'+['cite','misled'].map(function (kind) {
        return (m.memo[kind] || []).map(function (id) { return '<button type="button" class="mtag'+(kind === 'misled' ? ' bad' : '')+'" data-mm-act="tag" data-mm-id="'+esc(id)+'" data-mm-kind="'+kind+'" data-mm-seq="'+m.seq+'"><span>'+esc(fill(kind === 'cite' ? S.cites : S.misledTag,{id:id}))+'</span></button>'; }).join('');
      }).join('')+'</div>';
    }
    function tagDetail(seq,id,kind) {
      var m = ctx.state.bySeq.get(seq); if (!m || !m.memo) return;
      var known = Array.isArray(m.memo.uncounted), no = (m.memo.uncounted || []).find(function (x) { return x.id === id; });
      var title = fill(kind === 'cite' ? S.cites : S.misledTag,{id:id}), text = title;
      if (no) text = no.reason === 'own' ? S.uncountedOwn : no.reason === 'today' ? S.uncountedToday : fill(S.uncountedGone,{id:id});
      else if (known) text = fill(kind === 'cite' ? S.citeDetail : S.misledDetail,{id:id});
      mode = 'tag'; showSheet(title,'<p class="ml-read">'+esc(text)+'</p>'+button('show',id,' data-mm-id="'+esc(id)+'"','btn line'));
    }
    function click(e) {
      var b = e.target.closest('[data-mm-act]'); if (!b) return;
      var a = b.dataset.mmAct;
      if (a === 'close') close();
      else if (a === 'help') { mode = 'help'; showSheet(S.helpTitle,help()); }
      else if (a === 'source') source(b.dataset.mmSource);
      else if (a === 'tag') tagDetail(Number(b.dataset.mmSeq),b.dataset.mmId,b.dataset.mmKind);
      else if (a === 'new') return editShort(null,null);
      else if (a === 'replace') return editShort(null,short(b.dataset.mmId));
      else if (a === 'long') editLong(b.dataset.mmSlot,[]);
      else if (a === 'merge') editLong(b.dataset.mmSlot,current ? current.pending : []);
      else if (a === 'history') return viewList('history',b.dataset.mmSlot,true);
      else if (a === 'retired') return viewList('retired',null,true);
      else if (a === 'more') return viewList(mode,listSlot,false);
      else if (a === 'save') return save();
      else if (a === 'show') return show(b.dataset.mmId);
      else if (a === 'retire' || a === 'restore') return write({op:a,id:b.dataset.mmId});
      else if (a === 'restore-version') return write({op:'restore',slot:b.dataset.mmSlot,version:Number(b.dataset.mmVersion)});
      else if (a === 'vote') { var m = short(b.dataset.mmId); if (!m) return; var kind = b.dataset.mmVote; return write({op:'vote',id:m.id,vote:m.votes[kind].indexOf(ctx.state.me) >= 0 ? 'none' : kind}); }

    }
    document.addEventListener('input',function (e) {
      if (!form || mode !== 'editor') return;
      if (e.target.hasAttribute('data-mm-text')) form.text = e.target.value;
      else if (e.target.hasAttribute('data-mm-from')) form.from = e.target.value;
      else return;
      error = ''; updateEditorFoot();
    });
    document.addEventListener('click',click);
    document.addEventListener('keydown',function (e) { if (e.key === 'Escape' && mode) close(); });
    scrim.addEventListener('click',close);
    if (window.scorpioRoomOverlays) window.scorpioRoomOverlays.register('memo',function () { return !!mode; },close,sheet);
    ctx.menuHook('memo',function () {
      return ctx.canWrite() ? [{act:'savememo',label:S.saveMessage,hint:S.saveMessageHint,
        icon:'<svg class="mi" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
        run:function (m) { return editShort(m,null); }}] : [];
    });
    ctx.rowHook('memo',messageTags);
    ctx.panels.tab('memo',{html:html,label:function () { return esc(S.tab); },side:true,long:true,firstOpen:function () { if (!current) load(); }});
    return {frame:frame,refresh:refresh,html:html,close:close,show:show};
  };
})();
