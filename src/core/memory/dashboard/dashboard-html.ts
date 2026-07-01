export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Consilium Memory Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.29.2/cytoscape.min.js"></script>
  <style>
    #cy { width: 100%; height: 100%; }
    .tab-btn.active { border-bottom: 2px solid #6366f1; color: #6366f1; }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <header class="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
    <div>
      <h1 class="text-xl font-bold text-slate-900">Consilium Memory Dashboard</h1>
      <p id="summary-line" class="text-sm text-slate-500 mt-0.5">Loading...</p>
    </div>
    <div id="stats-pills" class="flex gap-3 text-xs flex-wrap"></div>
  </header>

  <!-- Tabs -->
  <div class="bg-white border-b border-slate-200 px-6 flex gap-6">
    <button class="tab-btn active py-3 text-sm font-medium text-slate-600 hover:text-indigo-600 transition-colors" data-tab="browse">Browse</button>
    <button class="tab-btn py-3 text-sm font-medium text-slate-600 hover:text-indigo-600 transition-colors" data-tab="graph">Graph</button>
  </div>

  <!-- Browse Tab -->
  <div id="tab-browse" class="p-6">
    <!-- Filters -->
    <div class="flex flex-wrap gap-3 mb-5">
      <input id="search-input" type="text" placeholder="Search memories..."
        class="flex-1 min-w-48 px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400" />
      <select id="scope-filter"
        class="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
        <option value="">All scopes</option>
      </select>
      <select id="sort-select"
        class="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
        <option value="updated">Last updated</option>
        <option value="created">Date created</option>
        <option value="title">Title A-Z</option>
        <option value="scope">Scope</option>
      </select>
      <select id="limit-select"
        class="px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
        <option value="20">20 / page</option>
        <option value="50">50 / page</option>
        <option value="100">100 / page</option>
      </select>
    </div>

    <!-- Table -->
    <div class="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      <table class="w-full text-sm">
        <thead class="bg-slate-50 border-b border-slate-200">
          <tr>
            <th class="text-left px-4 py-3 font-semibold text-slate-600 w-2/5">Title</th>
            <th class="text-left px-4 py-3 font-semibold text-slate-600">Scope</th>
            <th class="text-left px-4 py-3 font-semibold text-slate-600">Tags</th>
            <th class="text-left px-4 py-3 font-semibold text-slate-600 whitespace-nowrap">Updated</th>
          </tr>
        </thead>
        <tbody id="records-body">
          <tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">Loading...</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div class="flex items-center justify-between mt-4 text-sm text-slate-600">
      <span id="pagination-info"></span>
      <div class="flex gap-2">
        <button id="prev-btn"
          class="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          disabled>Prev</button>
        <button id="next-btn"
          class="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          disabled>Next</button>
      </div>
    </div>
  </div>

  <!-- Graph Tab -->
  <div id="tab-graph" class="hidden p-6">
    <div class="mb-3 flex items-center gap-5 text-xs text-slate-500">
      <span class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded-full bg-blue-400"></span>Tag node
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded bg-orange-400"></span>Scope node
      </span>
      <span class="flex items-center gap-1.5">
        <span class="inline-block w-3 h-3 rounded-full bg-slate-300"></span>Memory node
      </span>
      <span class="text-slate-400 ml-2">Click a tag or scope node to filter Browse tab</span>
    </div>
    <div class="bg-white rounded-xl border border-slate-200 shadow-sm" style="height: calc(100vh - 250px);">
      <div id="cy"></div>
    </div>
  </div>

  <script>
    // ---- State ----
    var currentOffset = 0;
    var currentTotal = 0;
    var searchTimer = null;
    var scopeOptions = new Set();
    var cyInstance = null;

    function getLimit() {
      return parseInt(document.getElementById('limit-select').value, 10);
    }

    // ---- Escape HTML ----
    function esc(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // ---- Tabs ----
    var tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        tabBtns.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('tab-browse').classList.add('hidden');
        document.getElementById('tab-graph').classList.add('hidden');
        var tab = btn.dataset.tab;
        document.getElementById('tab-' + tab).classList.remove('hidden');
        if (tab === 'graph') initGraph();
      });
    });

    // ---- Summary ----
    function loadSummary() {
      fetch('/api/summary')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          document.getElementById('summary-line').textContent =
            data.total + ' entries — today: ' + data.recency.today +
            '  week: ' + data.recency.week +
            '  month: ' + data.recency.month +
            '  older: ' + data.recency.older;

          var pills = document.getElementById('stats-pills');
          pills.innerHTML = Object.entries(data.byScope).map(function(entry) {
            var scope = entry[0], count = entry[1];
            return '<span class="px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 font-medium">' +
              esc(scope) + ' <b>' + count + '</b></span>';
          }).join('');

          var scopeFilter = document.getElementById('scope-filter');
          Object.keys(data.byScope).forEach(function(scope) {
            if (!scopeOptions.has(scope)) {
              scopeOptions.add(scope);
              var opt = document.createElement('option');
              opt.value = scope;
              opt.textContent = scope;
              scopeFilter.appendChild(opt);
            }
          });
        })
        .catch(function() {
          document.getElementById('summary-line').textContent = 'Failed to load summary';
        });
    }

    // ---- Records ----
    function loadRecords() {
      var q = document.getElementById('search-input').value.trim();
      var scope = document.getElementById('scope-filter').value;
      var sort = document.getElementById('sort-select').value;
      var limit = getLimit();

      var params = new URLSearchParams({ sort: sort, limit: limit, offset: currentOffset });
      if (q) params.set('q', q);
      if (scope) params.set('scope', scope);

      var tbody = document.getElementById('records-body');
      tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">Loading...</td></tr>';

      fetch('/api/memories?' + params.toString())
        .then(function(r) { return r.json(); })
        .then(function(data) {
          currentTotal = data.total;

          if (data.records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-slate-400">No entries found.</td></tr>';
          } else {
            tbody.innerHTML = data.records.map(function(r) {
              var tags = r.tags.map(function(t) {
                return '<span class="inline-block px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-600 mr-1">' + esc(t) + '</span>';
              }).join('');
              var updated = r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : '—';
              return '<tr class="border-t border-slate-100 hover:bg-slate-50 transition-colors">' +
                '<td class="px-4 py-3 font-medium text-slate-800">' + esc(r.title) + '</td>' +
                '<td class="px-4 py-3">' +
                  '<span class="inline-block px-2 py-0.5 rounded-full text-xs bg-indigo-50 text-indigo-700">' + esc(r.scope) + '</span>' +
                '</td>' +
                '<td class="px-4 py-3">' + (tags || '<span class="text-slate-300 text-xs">—</span>') + '</td>' +
                '<td class="px-4 py-3 text-slate-500 whitespace-nowrap">' + updated + '</td>' +
                '</tr>';
            }).join('');
          }

          var showing = currentOffset + data.records.length;
          document.getElementById('pagination-info').textContent =
            data.total === 0 ? 'No results' :
              'Showing ' + (currentOffset + 1) + '–' + showing + ' of ' + data.total;

          document.getElementById('prev-btn').disabled = currentOffset <= 0;
          document.getElementById('next-btn').disabled = !data.hasMore;
        })
        .catch(function() {
          tbody.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-red-400">Error loading records.</td></tr>';
        });
    }

    // ---- Pagination ----
    document.getElementById('prev-btn').addEventListener('click', function() {
      currentOffset = Math.max(0, currentOffset - getLimit());
      loadRecords();
    });
    document.getElementById('next-btn').addEventListener('click', function() {
      currentOffset += getLimit();
      loadRecords();
    });

    // ---- Filter listeners ----
    function resetAndLoad() { currentOffset = 0; loadRecords(); }

    document.getElementById('search-input').addEventListener('input', function() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(resetAndLoad, 300);
    });
    document.getElementById('scope-filter').addEventListener('change', resetAndLoad);
    document.getElementById('sort-select').addEventListener('change', resetAndLoad);
    document.getElementById('limit-select').addEventListener('change', function() {
      currentOffset = 0;
      loadRecords();
    });

    // ---- Graph ----
    function initGraph() {
      if (cyInstance) return;

      var cyEl = document.getElementById('cy');
      cyEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;">Loading graph...</div>';

      fetch('/api/graph')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          cyEl.innerHTML = '';
          cyInstance = cytoscape({
            container: cyEl,
            elements: data.nodes.concat(data.edges),
            style: [
              {
                selector: 'node[type="tag"]',
                style: {
                  'background-color': '#60a5fa',
                  'label': 'data(label)',
                  'font-size': '10px',
                  'color': '#1e3a5f',
                  'text-valign': 'bottom',
                  'text-margin-y': '4px',
                  'width': '28px',
                  'height': '28px',
                }
              },
              {
                selector: 'node[type="scope"]',
                style: {
                  'background-color': '#fb923c',
                  'shape': 'rectangle',
                  'label': 'data(label)',
                  'font-size': '10px',
                  'color': '#7c2d12',
                  'text-valign': 'bottom',
                  'text-margin-y': '4px',
                  'width': '44px',
                  'height': '24px',
                }
              },
              {
                selector: 'node[type="memory"]',
                style: {
                  'background-color': '#cbd5e1',
                  'label': 'data(label)',
                  'font-size': '7px',
                  'color': '#475569',
                  'text-valign': 'bottom',
                  'text-margin-y': '3px',
                  'width': '16px',
                  'height': '16px',
                  'text-max-width': '80px',
                  'text-wrap': 'ellipsis',
                }
              },
              {
                selector: 'edge',
                style: {
                  'width': 1,
                  'line-color': '#e2e8f0',
                  'curve-style': 'bezier',
                  'opacity': 0.6,
                }
              },
              {
                selector: ':selected',
                style: {
                  'background-color': '#6366f1',
                  'line-color': '#6366f1',
                }
              },
            ],
            layout: {
              name: 'cose',
              animate: false,
              nodeRepulsion: 8000,
              idealEdgeLength: 80,
              edgeElasticity: 100,
              numIter: 1000,
              gravity: 0.25,
            }
          });

          cyInstance.on('tap', 'node', function(evt) {
            var node = evt.target;
            var type = node.data('type');
            var label = node.data('label');
            if (type === 'tag') {
              // Switch to browse and search for this tag
              tabBtns[0].click();
              document.getElementById('search-input').value = label;
              resetAndLoad();
            } else if (type === 'scope') {
              // Switch to browse and filter by this scope
              tabBtns[0].click();
              var sel = document.getElementById('scope-filter');
              sel.value = label;
              resetAndLoad();
            }
          });
        })
        .catch(function() {
          cyEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#f87171;">Failed to load graph data.</div>';
        });
    }

    // ---- Init ----
    loadSummary();
    loadRecords();
  </script>
</body>
</html>
`;
