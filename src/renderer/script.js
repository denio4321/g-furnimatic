// Window controls
document.getElementById('min').onclick = () => window.api.minimize();
document.getElementById('max').onclick = () => window.api.maximize();
document.getElementById('close').onclick = () => window.api.close();

// Always on top toggle
document.getElementById('always-on-top-checkbox').addEventListener('change', (event) => {
  window.api.alwaysOntop(event.target.checked);
});

let allCards = [];

function renderCards(cardDataArray) {
  const container = document.getElementById('card-container');
  container.innerHTML = ''; // Efficient clean

  const fragment = document.createDocumentFragment();
  const cardTemplate = document.createElement('template');

  for (const { imgUrl, quantity, name } of cardDataArray) {
    cardTemplate.innerHTML = `
      <div class="card">
        <div class="image-wrapper">
          <img src="${imgUrl}" alt="${name}" />
          <div class="quantity-badge">x${quantity}</div>
        </div>
        <div class="item-name">${name}</div>
      </div>
    `.trim();

    const node = cardTemplate.content.cloneNode(true);
    node.querySelector('.card').addEventListener('click', () =>
      showSidePanel({ imgUrl, quantity, name })
    );
    fragment.appendChild(node);
  }

  container.appendChild(fragment);
}

function showSidePanel(card) {
  const panel = document.getElementById('side-panel');
  const backdrop = document.getElementById('panel-backdrop');
  const content = document.getElementById('panel-content');

  content.innerHTML = `
    <h2>${card.name}</h2>
    <img src="${card.imgUrl}" alt="${card.name}"/>
    <p>Quantity: ${card.quantity}</p>
    <button id="recycle-btn" class="recycle-btn">Add to the recycling queue</button>
  `;

  content.querySelector('#recycle-btn').addEventListener('click', () => {
    window.api.addToRecycleQueue(card);
  });

  panel.classList.add('show');
  backdrop.classList.add('show');
}

function hideSidePanel() {
  document.getElementById('side-panel').classList.remove('show');
  document.getElementById('panel-backdrop').classList.remove('show');
}

document.getElementById('close-panel').addEventListener('click', hideSidePanel);
document.getElementById('panel-backdrop').addEventListener('click', hideSidePanel);

// Receive cards from main process
window.api.onLoadCards((cardDataArray) => {
  allCards = cardDataArray;
  renderCards(allCards);
});

// Furnidata load status
window.api.furniDataLoaded((isLoaded) => {
  const statusElement = document.getElementById('furnidata-status');
  statusElement.textContent = isLoaded ? 'Furni data loaded.' : 'Furni data not loaded.';
  statusElement.classList.toggle('loaded', isLoaded);
  statusElement.classList.toggle('not-loaded', !isLoaded);
});

// Refresh inventory
document.getElementById('refresh-btn').addEventListener('click', () => {
  window.api.refresh();
});

// Debounced search
function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}

function filterCards(query) {
  const filtered = allCards.filter(card =>
    card.name.toLowerCase().includes(query.toLowerCase())
  );
  renderCards(filtered);
}

document.getElementById('search-box').addEventListener('input', debounce((e) => {
  filterCards(e.target.value.trim());
}, 200));

// Render recycling queue
function renderRecycleList(queue) {
  const list = document.getElementById('recycling-list');
  list.innerHTML = '';

  for (const card of queue) {
    const li = document.createElement('li');
    li.dataset.name = card.name;

    li.innerHTML = `
      <div class="recycling-item-info">
        <img src="${card.imgUrl}" alt="${card.name}" />
        <span>${card.name}</span>
      </div>
      <div class="recycling-item-actions">
        <span>x${card.quantity}</span>
        <button class="remove-btn" title="Remove from queue">🗑️</button>
      </div>
    `;

    li.querySelector('.remove-btn').addEventListener('click', () => {
      window.api.removeFromRecycleQueue(card.name);
    });

    list.appendChild(li);
  }
}

window.api.onRecycleListUpdate(renderRecycleList);
