// The window only draws the state the main process sends and forwards clicks; it keeps no state of its own
const bridge = window.api;
const { t, num } = window.i18n;
const $ = (id) => document.getElementById(id);
const BATCH_SIZE = 8;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let state = null;
let query = '';
let gridSignature = '';
let ticker = null;
let draining = false;
let language = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function furniImage(src, alt = '') {
  if (!src) return el('span', 'placeholder');

  const img = new Image();
  img.className = 'furni';
  img.alt = alt;
  img.decoding = 'async';
  img.src = src;
  img.addEventListener('error', () => img.replaceWith(el('span', 'placeholder')), { once: true });
  return img;
}

const furniName = (item) => item.name || t('unknown', { id: item.typeId });

// ---- Language ----

// Fixed texts carry their key in data-i18n attributes; everything else is worded while rendering
function applyLanguage() {
  const next = window.i18n.resolve(state.settings.language, state.hotel);
  if (next === language) return false;

  language = next;
  window.i18n.set(next);
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  return true;
}

// ---- Window chrome ----

$('min').addEventListener('click', () => bridge.minimize());
$('max').addEventListener('click', () => bridge.maximize());
$('close').addEventListener('click', () => bridge.close());
$('always-on-top').addEventListener('change', (event) => bridge.updateSettings({ alwaysOnTop: event.target.checked }));

// ---- Status bar ----

function setStatus(id, tone, text) {
  const node = $(id);
  node.hidden = !text;
  node.classList.remove('ok', 'busy', 'bad');
  if (tone) node.classList.add(tone);
  node.querySelector('.status-text').textContent = text || '';
}

function renderStatusBar() {
  const { hotel, furniData, duckets, batchCost } = state;

  setStatus('status-hotel', hotel ? 'ok' : null, hotel ? t('status.connected', { hotel }) : t('status.waiting'));

  const furniDataText = {
    waiting: '',
    loading: t('status.namesLoading'),
    ready: '',
    failed: t('status.namesFailed'),
  }[furniData];
  setStatus('status-furnidata', furniData === 'failed' ? 'bad' : 'busy', furniDataText);

  const ducketsText =
    duckets === null ? '' : t('status.duckets', { n: duckets }) + (batchCost ? `, ${t('status.perBatch', { cost: batchCost })}` : '');
  setStatus('status-duckets', null, ducketsText);
}

// ---- Inventory ----

function inventoryEmptyState() {
  const { hotel, furniData, inventory } = state;

  if (!hotel) return [t('empty.waiting.title'), t('empty.waiting.text')];
  if (furniData === 'failed') return [t('empty.namesFailed.title'), t('empty.namesFailed.text')];
  if (inventory.status === 'failed') return [t('empty.invFailed.title'), t('empty.invFailed.text')];
  if (inventory.status !== 'ready' || furniData !== 'ready') return [t('empty.loading.title'), ''];
  if (inventory.cards.length === 0) return [t('empty.none.title'), t('empty.none.text')];
  return null;
}

// Furni known to sell for more than the safe price stay out of the list unless asked for
let showExpensive = false;

function isExpensive(card) {
  const cap = state.settings.priceCap;
  return cap > 0 && card.price?.status === 'known' && card.price.average > cap;
}

function hidingExpensive() {
  return state.settings.hideExpensive && !showExpensive;
}

function visibleCards() {
  const needle = query.toLowerCase();
  let cards = state.inventory.cards;
  if (hidingExpensive()) cards = cards.filter((card) => !isExpensive(card));
  return needle ? cards.filter((card) => furniName(card).toLowerCase().includes(needle)) : cards;
}

function renderHiddenNote() {
  const expensive = state.inventory.cards.filter(isExpensive).length;
  $('hidden-note').hidden = !state.settings.hideExpensive || expensive === 0;
  $('hidden-text').textContent = t('inv.hidden', { n: expensive, cap: state.settings.priceCap });
  $('hidden-toggle').textContent = t(showExpensive ? 'inv.hide' : 'inv.show');
}

$('hidden-toggle').addEventListener('click', () => {
  showExpensive = !showExpensive;
  renderInventory(true);
});

function renderInventory(force) {
  const { inventory, queue } = state;
  const cards = inventory.cards;
  const total = cards.reduce((sum, card) => sum + card.quantity, 0);

  let summary = '';
  if (inventory.status === 'loading' && inventory.progress) {
    summary = t('inv.loadingPart', { a: inventory.progress[0], b: inventory.progress[1] });
  } else if (inventory.status === 'ready' && cards.length) {
    summary = t('inv.summary', { n: total, k: cards.length });
  }
  $('inventory-summary').textContent = summary;
  renderHiddenNote();

  const queued = new Set(queue.map((entry) => entry.typeId));
  const visible = visibleCards();

  let empty = inventoryEmptyState();
  if (!empty && visible.length === 0) empty = [t('empty.search.title', { q: query }), t('empty.search.text')];

  $('inventory-empty').hidden = !empty;
  $('inventory-grid').hidden = !!empty;
  if (empty) {
    $('inventory-empty-title').textContent = empty[0];
    $('inventory-empty-text').textContent = empty[1];
  }

  // Bulk add only follows a search, so "everything" is never one click away
  const addable = query ? visible.filter((card) => !card.locked && !queued.has(card.typeId)) : [];
  $('add-results').hidden = addable.length === 0;
  $('add-results').textContent = t('inv.addResults', { n: addable.length });

  const hiddenIds = visible.length === cards.length ? '' : visible.map((card) => card.typeId).join(',');
  const signature = `${inventory.version}|${[...queued].join(',')}|${query.toLowerCase()}|${language}|${hiddenIds}`;
  if (signature === gridSignature && !force) return;
  gridSignature = signature;

  // Rebuilding the grid would drop keyboard focus, so put it back on the same furni
  const focused = document.activeElement?.closest?.('.tile');
  const focusedId = focused?.dataset.typeId;
  const focusedLock = document.activeElement?.classList.contains('tile-lock');

  $('inventory-grid').replaceChildren(...visible.map((card) => tile(card, queued.has(card.typeId))));

  if (focusedId) {
    const again = $('inventory-grid').querySelector(`[data-type-id="${focusedId}"]`);
    again?.querySelector(focusedLock ? '.tile-lock' : '.tile-main')?.focus();
  }
}

function tile(card, isQueued) {
  const name = furniName(card);
  const item = el('div', 'tile');
  item.setAttribute('role', 'listitem');
  item.dataset.typeId = card.typeId;
  item.classList.toggle('queued', isQueued);
  item.classList.toggle('locked', card.locked);

  const main = el('button', 'tile-main');
  main.type = 'button';
  main.disabled = card.locked;
  main.setAttribute('aria-pressed', String(isQueued));
  const price = card.price?.status === 'known' ? `\n${t('price.known', { n: card.price.average })}` : '';
  main.title = (card.locked ? t('tile.locked', { name }) : t(isQueued ? 'tile.remove' : 'tile.add', { name })) + price;

  const well = el('span', 'well');
  well.append(furniImage(card.imgUrl), el('span', 'qty', `×${num(card.quantity)}`));
  main.append(well, el('span', 'tile-name', name));
  main.addEventListener('click', () => bridge.toggleQueue(card.typeId));

  const lock = el('button', 'tile-lock');
  lock.type = 'button';
  lock.setAttribute('aria-pressed', String(card.locked));
  lock.title = t(card.locked ? 'tile.unlock' : 'tile.lock', { name });
  lock.setAttribute('aria-label', lock.title);
  lock.append(icon('lock'));
  lock.addEventListener('click', () => bridge.toggleLock(card.typeId));

  item.append(main, lock);
  return item;
}

let searchTimer;
$('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    query = event.target.value.trim();
    if (state) renderInventory();
  }, 120);
});

$('search').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !event.target.value) return;
  event.stopPropagation();
  event.target.value = '';
  query = '';
  renderInventory();
});

$('add-results').addEventListener('click', () => {
  const queued = new Set(state.queue.map((entry) => entry.typeId));
  bridge.addManyToQueue(visibleCards().filter((card) => !card.locked && !queued.has(card.typeId)).map((card) => card.typeId));
});

$('reload').addEventListener('click', () => bridge.refreshInventory());

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    $('search').focus();
    $('search').select();
  }
});

// ---- Hopper ----

const slots = Array.from({ length: BATCH_SIZE }, (_, i) => {
  const slot = el('span', 'slot');
  slot.style.setProperty('--i', i);
  $('hopper').append(slot);
  return slot;
});

function fillHopper(urls) {
  slots.forEach((slot, i) => {
    const src = urls[i] ?? '';
    if (slot.dataset.src === src && slot.childElementCount === (src ? 1 : 0)) return;
    slot.dataset.src = src;
    slot.classList.toggle('filled', !!src);
    slot.replaceChildren(...(src ? [furniImage(src)] : []));
  });
}

function renderHopper(previous) {
  const { recycler } = state;
  const confirmed = previous && recycler.batchesSent > previous.recycler.batchesSent;

  if (confirmed && !reducedMotion.matches) {
    draining = true;
    $('hopper').classList.add('drain');
    setTimeout(() => {
      draining = false;
      $('hopper').classList.remove('drain');
      fillHopper(state.recycler.nextBatch);
    }, 480);
  } else if (!draining) {
    fillHopper(recycler.nextBatch);
  }

  const meter = $('hopper-meter');
  meter.classList.toggle('busy', recycler.phase === 'checking' || recycler.phase === 'recycling');
  if (recycler.phase !== 'cooldown') meter.style.setProperty('--progress', 0);
}

// ---- Furni-Matic status ----

function noticeText(notice) {
  const prefix = notice.code === 'heldBack' || notice.code === 'leftover';
  const recycled = prefix && notice.values.recycled ? t('notice.recycled', notice.values) : '';
  return recycled + t(`notice.${notice.code}`, notice.values);
}

function idleHint() {
  const { queue, recycler } = state;

  if (recycler.notice) {
    return [noticeText(recycler.notice), recycler.notice.tone === 'error' ? 'error' : recycler.notice.tone];
  }
  if (queue.length === 0) return [t('hint.empty'), ''];
  if (recycler.checking > 0) return [t('hint.checking'), ''];

  const parts = [];
  if (recycler.heldBack > 0) parts.push(t('hint.heldBack', { n: recycler.heldBack }));
  if (recycler.leftover > 0) {
    parts.push(t('hint.leftover', { left: recycler.leftover, missing: BATCH_SIZE - recycler.leftover }));
  }
  return [parts.length ? parts.join(' ') : t('hint.ready'), ''];
}

// Time left comes from how long the batches of this run have taken so far
function eta(recycler) {
  if (!recycler.cycleMs || recycler.batchesLeft === 0) return '';
  const minutes = Math.round((recycler.cycleMs * recycler.batchesLeft) / 60000);
  return t('run.eta', { m: minutes });
}

function runningText(recycler) {
  const base = {
    checking: t('run.checking'),
    recycling: t('run.recycling'),
    cooldown: t('run.next', { s: Math.max(0, Math.ceil((recycler.cooldownUntil - Date.now()) / 1000)) }),
    idle: '',
  }[recycler.phase];
  const left = eta(recycler);
  return left ? `${base}, ${left}` : base;
}

function renderRecycler() {
  const { recycler, hotel } = state;

  $('batches-count').textContent = num(recycler.batchesLeft);
  $('batches-count').classList.toggle('zero', recycler.batchesLeft === 0);
  $('batches-label').textContent = t('readout.batches', { n: recycler.batchesLeft });

  let text;
  let tone = 'running';
  if (recycler.running || recycler.phase === 'recycling') text = runningText(recycler);
  else [text, tone] = idleHint();

  const status = $('recycler-status');
  status.textContent = text;
  status.className = `status-line ${tone}`;

  // The button says exactly how much it's about to recycle
  const run = $('run');
  const ready = recycler.batchesLeft * BATCH_SIZE;
  run.classList.toggle('stop', recycler.running);
  run.textContent = recycler.running ? t('run.stop') : ready > 0 ? t('run.start', { n: ready }) : t('run.startChecking');
  run.disabled = !recycler.running && !(hotel && (ready > 0 || recycler.checking > 0));
  run.title = run.disabled ? t('run.disabled', { size: BATCH_SIZE }) : '';

  // A single batch, for trying it out or for going slowly
  const once = $('run-once');
  once.hidden = recycler.running;
  once.disabled = !(hotel && ready > 0);

  // The countdown ticks here; the main process only sends the moment it ends
  clearInterval(ticker);
  if (recycler.phase === 'cooldown' && recycler.cooldownUntil) {
    const tick = () => {
      const left = recycler.cooldownUntil - Date.now();
      status.textContent = runningText(recycler);
      $('hopper-meter').style.setProperty('--progress', 1 - Math.max(0, left) / recycler.cooldownTotal);
    };
    tick();
    ticker = setInterval(tick, 200);
  }
}

$('run').addEventListener('click', () => (state.recycler.running ? bridge.stop() : bridge.start()));
$('run-once').addEventListener('click', () => bridge.recycleOnce());

// ---- Queue ----

const rows = new Map();

function priceLine(entry) {
  const cap = state.settings.priceCap;
  const price = entry.price;

  switch (price.status) {
    case 'loading':
      return [t('price.loading'), false];
    case 'unsellable':
      return [t('price.unsellable'), false];
    case 'none':
      return [t('price.none'), false];
    case 'failed':
      return [t('price.failed'), cap > 0];
    case 'known': {
      const over = cap > 0 && price.average > cap;
      return [t('price.known', { n: price.average }) + (over ? t('price.over', { cap }) : ''), over];
    }
  }
}

function queueRow(entry) {
  const row = el('li', 'queue-row');

  const well = el('span', 'well');
  const name = el('span', 'queue-name');
  const remove = el('button', 'icon-button queue-remove');
  remove.type = 'button';
  remove.append(icon('close'));
  remove.addEventListener('click', () => bridge.removeFromQueue(entry.typeId));

  const count = el('span', 'queue-count');

  const stepper = el('span', 'stepper');
  const keepLabel = el('span', 'stepper-label');
  const less = el('button');
  less.type = 'button';
  less.append(icon('minus'));
  const input = el('input');
  input.type = 'number';
  input.min = '0';
  const more = el('button');
  more.type = 'button';
  more.append(icon('plus'));
  stepper.append(keepLabel, less, input, more);

  const price = el('span', 'price');
  const priceText = el('span');
  const allow = el('button', 'text-button');
  allow.type = 'button';
  price.append(priceText, allow);

  row.append(well, name, remove, count, stepper, price);

  const parts = { row, well, name, remove, count, keepLabel, input, less, more, price, priceText, allow, src: null };
  less.addEventListener('click', () => bridge.setKeep(entry.typeId, Number(input.value) - 1));
  more.addEventListener('click', () => bridge.setKeep(entry.typeId, Number(input.value) + 1));
  input.addEventListener('change', () => bridge.setKeep(entry.typeId, Number(input.value) || 0));
  allow.addEventListener('click', () => bridge.toggleAllowed(entry.typeId));
  return parts;
}

function updateRow(parts, entry) {
  const name = furniName(entry);

  if (parts.src !== entry.imgUrl) {
    parts.src = entry.imgUrl;
    parts.well.replaceChildren(furniImage(entry.imgUrl));
  }

  parts.name.textContent = name;
  parts.name.title = name;
  parts.remove.title = t('row.remove', { name });
  parts.remove.setAttribute('aria-label', parts.remove.title);

  const toRecycle = Math.max(0, entry.available - entry.keep);
  parts.count.textContent = t('row.count', { a: toRecycle, b: entry.available });
  parts.keepLabel.textContent = t('row.keep');

  // Don't overwrite a number the person is still typing
  if (document.activeElement !== parts.input) parts.input.value = entry.keep;
  parts.input.max = entry.available;
  parts.input.setAttribute('aria-label', t('row.keepLabel', { name }));
  parts.less.disabled = entry.keep <= 0;
  parts.less.setAttribute('aria-label', t('row.less', { name }));
  parts.more.disabled = entry.keep >= entry.available;
  parts.more.setAttribute('aria-label', t('row.more', { name }));

  const [text, warn] = priceLine(entry);
  parts.priceText.textContent = entry.allowed && warn ? text + t('price.allowed') : text;
  parts.price.classList.toggle('warn', warn && !entry.allowed);
  parts.allow.hidden = !warn;
  parts.allow.textContent = t(entry.allowed ? 'price.undo' : 'price.allow');
}

function renderQueue() {
  const { queue } = state;
  const list = $('queue');
  const seen = new Set();

  for (const entry of queue) {
    let parts = rows.get(entry.typeId);
    if (!parts) {
      parts = queueRow(entry);
      rows.set(entry.typeId, parts);
    }
    updateRow(parts, entry);
    list.append(parts.row);
    seen.add(entry.typeId);
  }

  for (const [typeId, parts] of rows) {
    if (seen.has(typeId)) continue;
    parts.row.remove();
    rows.delete(typeId);
  }

  $('queue-empty').hidden = queue.length > 0;
  $('clear-queue').hidden = queue.length === 0;
}

$('clear-queue').addEventListener('click', () => bridge.clearQueue());

// ---- Prizes: the last one next to the machine, every one of them in the log tab ----

const timeFormat = () => new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'short', timeStyle: 'short' });

// Without the prize table there's no rarity to show, rather than claiming a prize isn't in it
function rarityText(prize, withLevel) {
  if (prize.tier === null) return state.prizeLevels.length ? t('log.notInTable') : '';
  const parts = [t(`tier.${prize.tier}`)];
  if (withLevel) parts.push(t('log.level', prize));
  parts.push(t('log.odds', prize));
  return parts.join(', ');
}

function prizeWell(prize) {
  const well = el('span', 'well');
  well.append(furniImage(prize.imgUrl, prize.name || ''));
  return well;
}

let lootSignature = '';

function renderPrizes() {
  const { loot, prizeLevels } = state;
  const signature = `${language}|${prizeLevels.length}|${loot.map((p) => `${p.key}${p.status}${p.tier ?? ''}`).join(',')}`;
  if (signature === lootSignature) return;
  lootSignature = signature;

  const opened = loot.filter((prize) => prize.status === 'opened');
  $('tab-log').textContent = t('tabs.log', { n: opened.length });

  const last = opened[0];
  $('last-prize').hidden = !last;
  if (last) {
    const name = last.name || t('unknown', { id: '' });
    $('last-prize').dataset.tier = last.tier ?? '';
    $('last-prize-well').replaceChildren(furniImage(last.imgUrl, name));
    $('last-prize-name').textContent = name;
    $('last-prize').title = rarityText(last, true);
    $('prizes-log').textContent = t('prizes.seeLog');
  }

  renderLog(opened);
}

function renderLog(opened) {
  const { prizeLevels } = state;
  $('log-empty').hidden = opened.length > 0;
  $('log').hidden = opened.length === 0;

  // One chip per rarity, rarest last like in the Furni-Matic's prize table
  const chips = [el('span', 'log-chip total', t('log.total', { n: opened.length }))];
  for (const level of prizeLevels) {
    const n = opened.filter((prize) => prize.tier === level.tier && prize.level === level.level).length;
    const chip = el('span', 'log-chip');
    chip.dataset.tier = level.tier;
    chip.title = `${t('log.level', level)}, ${t('log.odds', level)}`;
    chip.append(el('span', 'log-chip-name', t(`tier.${level.tier}`)), el('span', 'log-chip-count', num(n)));
    chips.push(chip);
  }
  $('log-stats').replaceChildren(...chips);
  $('log-stats').hidden = opened.length === 0;

  const format = timeFormat();
  $('log').replaceChildren(
    ...opened.map((prize) => {
      const row = el('li', 'log-row opened');
      if (prize.tier !== null) row.dataset.tier = prize.tier;

      const text = el('span', 'log-text');
      text.append(el('span', 'log-name', prize.name || t('unknown', { id: '' })));
      const rarity = rarityText(prize, true);
      if (rarity) text.append(el('span', 'log-rarity', rarity));

      row.append(prizeWell(prize), text, el('time', 'log-time', format.format(prize.at)));
      return row;
    })
  );
}

// ---- Tabs ----

let tab = 'inventory';

function setTab(next) {
  tab = next;
  const onLog = tab === 'log';
  $('tab-inventory').setAttribute('aria-selected', String(!onLog));
  $('tab-log').setAttribute('aria-selected', String(onLog));
  $('inventory-view').hidden = onLog;
  $('inventory-tools').hidden = onLog;
  $('log-view').hidden = !onLog;
}

$('tab-inventory').addEventListener('click', () => setTab('inventory'));
$('tab-log').addEventListener('click', () => setTab('log'));
$('prizes-log').addEventListener('click', () => setTab('log'));

// ---- Prize boxes: placed on a chosen tile of a room you own, opened, prize picked back up ----

function renderBoxes() {
  const { boxes, room, settings } = state;
  const text = $('boxes-text');
  const button = $('boxes-button');
  const owner = room === 'owner';

  const count = boxes.waiting ? t('boxes.waiting', { n: boxes.waiting }) : t('boxes.none');
  let message = count;
  let tone = '';
  if (boxes.running) message = t('boxes.opening', { a: Math.min(boxes.done + 1, boxes.total), b: boxes.total });
  else if (boxes.failed) [message, tone] = [t(`boxes.failed.${boxes.failed}`), 'warn'];
  else if (room === 'unknown') [message, tone] = [`${count} ${t('boxes.reenter')}`, 'warn'];
  else if (!owner) message = `${count} ${t('boxes.enterRoom')}`;
  else if (boxes.picking) [message, tone] = [t('boxes.picking'), 'picking'];
  else if (!boxes.spot) message = `${count} ${t('boxes.needSpot')}`;
  text.textContent = message;
  text.className = `boxes-text ${tone}`;

  // The tile row: where boxes go, or the button to pick it
  $('boxes-spot').hidden = !owner;
  $('boxes-spot-text').textContent = boxes.spot ? t('boxes.spot', boxes.spot) : t('boxes.spotLabel');
  const spotButton = $('boxes-spot-button');
  spotButton.textContent = t(boxes.picking ? 'boxes.cancel' : boxes.spot ? 'boxes.changeSpot' : 'boxes.chooseSpot');
  spotButton.disabled = boxes.running;

  button.hidden = !owner || !boxes.spot || (!boxes.running && boxes.waiting === 0);
  button.classList.toggle('stop', boxes.running);
  $('boxes-button-text').textContent = boxes.running ? t('boxes.stop') : t('boxes.placeAll', { n: boxes.waiting });
  spotButton.classList.toggle('accent', !boxes.spot && !boxes.picking);

  $('auto-open').checked = settings.autoOpen;
}

$('boxes-spot-button').addEventListener('click', () => bridge.pickSpot(!state.boxes.picking));
$('boxes-button').addEventListener('click', () => (state.boxes.running ? bridge.stopBoxes() : bridge.openBoxes()));
$('auto-open').addEventListener('change', (event) => bridge.updateSettings({ autoOpen: event.target.checked }));

// ---- Safeguard: furni over the price limit wait here for a yes or no ----

let guarded = [];
// Answered furni stay out until the main process confirms, so the dialog doesn't come back for them
const answered = new Set();

function renderGuard() {
  const dialog = $('guard');
  const cap = state.settings.priceCap;
  const waiting = state.queue.filter(
    (entry) => entry.heldBack && (entry.price.status === 'known' || entry.price.status === 'failed')
  );
  for (const typeId of answered) if (!waiting.some((entry) => entry.typeId === typeId)) answered.delete(typeId);
  guarded = waiting.filter((entry) => !answered.has(entry.typeId));

  if (guarded.length === 0) {
    if (dialog.open) dialog.close();
    return;
  }

  const one = guarded.length === 1;
  $('guard-title').textContent = t(one ? 'guard.titleOne' : 'guard.titleMany');
  $('guard-text').textContent = t(one ? 'guard.textOne' : 'guard.textMany', { cap });
  $('guard-list').replaceChildren(
    ...guarded.map((entry) => {
      const row = el('li', 'guard-item');
      const well = el('span', 'well');
      well.append(furniImage(entry.imgUrl));
      const price = entry.price.status === 'known' ? t('price.known', { n: entry.price.average }) : t('price.failed');
      const text = el('span', 'guard-item-text');
      text.append(el('span', 'guard-item-name', furniName(entry)), el('span', 'guard-item-price', price));
      row.append(well, text);
      return row;
    })
  );

  // The safe answer has the focus, so Enter or a stray click doesn't recycle anything expensive
  if (!dialog.open) {
    dialog.showModal();
    $('guard-remove').focus();
  }
}

function answerGuard(allow) {
  const ids = guarded.map((entry) => entry.typeId);
  ids.forEach((typeId) => answered.add(typeId));
  if (allow) bridge.allowMany(ids);
  else ids.forEach((typeId) => bridge.removeFromQueue(typeId));
  guarded = [];
  $('guard').close();
}

$('guard-allow').addEventListener('click', () => answerGuard(true));
$('guard-remove').addEventListener('click', () => answerGuard(false));
// Escape counts as the safe answer
$('guard').addEventListener('cancel', (event) => {
  event.preventDefault();
  answerGuard(false);
});

// ---- Settings ----

function showSettings(open) {
  $('settings').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
}

$('settings-toggle').addEventListener('click', () => showSettings($('settings').hidden));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('settings').hidden) {
    showSettings(false);
    $('settings-toggle').focus();
  }
});

document.addEventListener('pointerdown', (event) => {
  const inside = event.target instanceof Element && event.target.closest('#settings, #settings-toggle');
  if (!$('settings').hidden && !inside) showSettings(false);
});

$('settings').addEventListener('submit', (event) => event.preventDefault());
$('price-cap').addEventListener('change', (event) => bridge.updateSettings({ priceCap: Number(event.target.value) || 0 }));
$('default-keep').addEventListener('change', (event) =>
  bridge.updateSettings({ defaultKeep: Number(event.target.value) || 0 })
);
$('language').addEventListener('change', (event) => bridge.updateSettings({ language: event.target.value }));
$('hide-expensive').addEventListener('change', (event) => bridge.updateSettings({ hideExpensive: event.target.checked }));

function renderSettings() {
  const { settings } = state;
  if (document.activeElement !== $('price-cap')) $('price-cap').value = settings.priceCap;
  if (document.activeElement !== $('default-keep')) $('default-keep').value = settings.defaultKeep;
  $('language').value = settings.language;
  $('always-on-top').checked = settings.alwaysOnTop;
  $('hide-expensive').checked = settings.hideExpensive;
}

// ---- State ----

function render(next) {
  const previous = state;
  state = next;

  const languageChanged = applyLanguage();
  renderStatusBar();
  renderInventory(languageChanged);
  renderHopper(previous);
  renderRecycler();
  renderQueue();
  renderPrizes();
  renderBoxes();
  renderSettings();
  renderGuard();
}

bridge.onState(render);
bridge.getState().then((initial) => {
  if (!state) render(initial);
});
