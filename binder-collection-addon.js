/* โหลดหลังสคริปต์หลัก และ binder-cover-addon.js ถ้ามี */
(() => {
    'use strict';

    const shelf = document.getElementById('binder-shelf');
    const grid = document.getElementById('binder-shelf-grid');

    if (!shelf || !grid || document.getElementById('bc-tools')) return;

    const $ = id => document.getElementById(id);

    const esc = value => String(value ?? '').replace(
        /[&<>"']/g,
        c => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[c])
    );

    const clean = value => String(value ?? '').trim();
    const yes = value => clean(value).toLowerCase() === 'true';

    const owned = card =>
        !yes(card.isWishlist) &&
        Number.isFinite(Number(card.qty)) &&
        Number(card.qty) > 0;

    const code = value =>
        clean(value).toUpperCase().replace(/\s+/g, '');

    const filters = [
        ['all', 'ทั้งหมด'],
        ['owned', 'มีการ์ด'],
        ['empty', 'แฟ้มว่าง'],
        ['pinned', 'ปักหมุด']
    ];

    let filter = 'all';
    let view = 'shelf';
    let query = '';
    let threshold = 75;
    let groups = [];

    // ===== รูปแบบหน้าตา =====
    const css = document.createElement('style');

    css.textContent = `
        #binder-shelf [hidden] {
            display: none !important;
        }

        #bc-tools {
            margin-top: 16px;
            color: #334155;
            font-size: 13px;
        }

        #bc-tools input,
        #bc-tools select {
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            padding: 10px;
            background: white;
            max-width: 100%;
            font: inherit;
        }

        #bc-search {
            width: 100%;
            margin: 10px 0;
        }

        .bc-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: center;
        }

        .bc-button {
            padding: 9px 12px;
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            background: white;
            font: inherit;
            cursor: pointer;
            color: #334155;
        }

        .bc-button[aria-pressed=true] {
            background: #065f46;
            border-color: #065f46;
            color: white;
        }

        #bc-tools :focus-visible,
        #bc-overview :focus-visible {
            outline: 3px solid #10b981;
            outline-offset: 2px;
        }

        .bc-note {
            font-size: 12px;
            line-height: 1.7;
            color: #64748b;
            margin: 10px 0;
        }

        #bc-overview {
            margin-top: 16px;
            color: #334155;
            font-size: 13px;
        }

        #bc-results {
            display: grid;
            grid-template-columns:
                repeat(auto-fit, minmax(min(100%, 280px), 1fr));
            gap: 12px;
        }

        .bc-card {
            background: white;
            border: 1px solid #e2e8f0;
            border-radius: 16px;
            padding: 16px;
            min-width: 0;
            overflow-wrap: anywhere;
        }

        .bc-card h3 {
            font-size: 15px;
            font-weight: 800;
            margin: 0;
        }

        .bc-card progress {
            width: 100%;
            height: 9px;
            accent-color: #059669;
            margin: 10px 0;
        }

        .bc-card summary {
            cursor: pointer;
            padding: 10px 0;
            font-weight: 600;
        }

        .bc-numbers {
            max-height: 160px;
            overflow: auto;
            line-height: 1.9;
            white-space: pre-wrap;
            padding: 10px;
            background: #f8fafc;
            border-radius: 10px;
            margin-bottom: 10px;
        }

        #bc-empty {
            padding: 24px 0;
            text-align: center;
            color: #64748b;
            font-size: 13px;
        }
    `;

    document.head.append(css);

    // ===== แถบค้นหาและตัวกรอง =====
    const tools = document.createElement('div');
    tools.id = 'bc-tools';

    tools.innerHTML = `
        <div class="bc-row" aria-label="มุมมองชั้นวาง">
            <button
                type="button"
                class="bc-button"
                data-view="shelf"
                aria-pressed="true"
            >📚 ชั้นวาง</button>

            <button
                type="button"
                class="bc-button"
                data-view="near"
                aria-pressed="false"
            >🎯 Set ใกล้ครบ</button>
        </div>

        <input
            id="bc-search"
            type="search"
            placeholder="ค้นหาชื่อ Set หรือรหัส Set…"
            aria-label="ค้นหาชื่อ Set หรือรหัส Set"
        >

        <div id="bc-filters" class="bc-row">
            ${filters.map(([key, label]) => `
                <button
                    type="button"
                    class="bc-button"
                    data-filter="${key}"
                    aria-pressed="${key === filter}"
                >${label}</button>
            `).join('')}
        </div>

        <div id="bc-threshold-row" class="bc-row" hidden>
            <label for="bc-threshold">สะสมแล้วอย่างน้อย</label>

            <select id="bc-threshold">
                <option value="75">75%</option>
                <option value="90">90%</option>
                <option value="50">50%</option>
                <option value="0">ทุกชุดที่ยังไม่ครบ</option>
            </select>
        </div>

        <p id="bc-count" class="bc-note" role="status"></p>
    `;

    grid.before(tools);

    // ===== หน้ารวม Set ใกล้ครบ =====
    const panel = document.createElement('section');
    panel.id = 'bc-overview';
    panel.hidden = true;

    panel.innerHTML = `
        <h2 style="font-size:18px;font-weight:800">
            🎯 ตามเก็บ Set ให้ครบ
        </h2>

        <p class="bc-note">
            นับเลขการ์ดไม่ซ้ำ แยกตามรหัส Set และภาษา
            ไม่รวม Wishlist และจำนวน 0 ใบ<br>
            จำนวนทั้งหมดอ้างอิงเลขหลัง / เช่น 001/130
            = ชุดพื้นฐาน 130 ใบ
            ไม่รวม Secret เกินเลขชุดหรือรุ่นฟอยล์ต่าง ๆ
        </p>

        <div id="bc-results"></div>

        <details
            id="bc-unknown"
            class="bc-note"
            hidden
        ></details>
    `;

    grid.after(panel);

    const empty = document.createElement('p');
    empty.id = 'bc-empty';
    empty.hidden = true;
    panel.after(empty);

    // ===== อ่านข้อมูลและคำนวณความคืบหน้า =====
    function readData() {
        const shelves = new Map();
        const variants = new Map();

        function ensure(name) {
            if (!shelves.has(name)) {
                shelves.set(name, {
                    name,
                    cards: [],
                    hasCards: false,
                    pinned: false
                });
            }

            return shelves.get(name);
        }

        for (const card of allCards) {
            const name = clean(card.set);
            if (!name) continue;

            const shelfData = ensure(name);
            shelfData.cards.push(card);
            shelfData.hasCards ||= owned(card);

            const setCode = code(card.setCode);
            const language = clean(card.language).toUpperCase();
            const key = JSON.stringify([name, setCode, language]);

            if (!variants.has(key)) {
                variants.set(key, {
                    key,
                    name,
                    setCode,
                    language,
                    cards: []
                });
            }

            variants.get(key).cards.push(card);
        }

        if (typeof allBinderSettings !== 'undefined') {
            for (const style of allBinderSettings) {
                const name = clean(style.setName);
                if (name) ensure(name);
            }
        }

        for (const shelfData of shelves.values()) {
            shelfData.pinned = yes(
                getBinderStyle(shelfData.name)?.pinned
            );
        }

        groups = [...variants.values()].map(group => {
            const totals = new Set();
            const numbers = new Set();

            for (const card of group.cards) {
                const match = clean(card.cardNumber).match(
                    /^(\d{1,4})(?:\s*\/\s*(\d{1,4}))?$/
                );

                if (!match) continue;

                const number = Number(match[1]);
                const total = Number(match[2]);

                if (total > 0 && total <= 2000) {
                    totals.add(total);
                }

                if (owned(card) && number > 0) {
                    numbers.add(number);
                }
            }

            group.total = totals.size === 1
                ? [...totals][0]
                : 0;

            group.reason = totals.size > 1
                ? 'เลขจำนวนทั้งหมดหลัง / ไม่ตรงกัน'
                : 'ยังไม่มีเลขการ์ดแบบ 001/130 ที่ใช้ระบุจำนวนทั้งหมด';

            group.missing = group.total
                ? Array.from(
                    { length: group.total },
                    (_, index) => index + 1
                ).filter(number => !numbers.has(number))
                : [];

            group.count = group.total - group.missing.length;

            group.percent = group.total
                ? 100 * group.count / group.total
                : 0;

            return group;
        });

        return shelves;
    }

    function matches(values) {
        return values.some(value =>
            clean(value).toLocaleLowerCase().includes(query) ||
            code(value).includes(code(query))
        );
    }

    function label(group) {
        return `${group.setCode || 'ไม่ระบุรหัส Set'} · ` +
            `${group.language || 'ไม่ระบุภาษา'}`;
    }

    function missingText(group) {
        return group.missing.map(number => {
            const padded = String(number).padStart(
                String(group.total).length,
                '0'
            );

            return `${padded}/${group.total}`;
        }).join(', ');
    }

    function accepts(shelfData, key) {
        return key === 'all' ||
            (key === 'owned' && shelfData.hasCards) ||
            (key === 'empty' && !shelfData.hasCards) ||
            (key === 'pinned' && shelfData.pinned);
    }

    // ===== อัปเดตหน้าจอ =====
    function refresh() {
        const expanded = new Set(
            [...panel.querySelectorAll('details[data-key][open]')]
                .map(details => details.dataset.key)
        );

        const shelves = readData();

        grid.hidden = view !== 'shelf';
        panel.hidden = view !== 'near';

        $('bc-filters').hidden = view !== 'shelf';
        $('bc-threshold-row').hidden = view !== 'near';

        tools.querySelectorAll('[data-view]').forEach(button => {
            button.setAttribute(
                'aria-pressed',
                button.dataset.view === view
            );
        });

        tools.querySelectorAll('[data-filter]').forEach(button => {
            const key = button.dataset.filter;

            const count = [...shelves.values()].filter(
                shelfData => accepts(shelfData, key)
            ).length;

            const title = filters.find(item => item[0] === key)[1];

            button.textContent = `${title} (${count})`;
            button.setAttribute('aria-pressed', key === filter);
        });

        let visible = 0;

        grid.querySelectorAll('.binder-shelf-item').forEach(item => {
            const name = item.querySelector(
                '.set-binder[data-set]'
            )?.dataset.set;

            const shelfData = shelves.get(name);

            item.hidden = !shelfData ||
                !accepts(shelfData, filter) ||
                !matches([
                    shelfData.name,
                    ...shelfData.cards.map(card => card.setCode)
                ]);

            if (!item.hidden) visible++;
        });

        empty.hidden =
            view !== 'shelf' ||
            visible > 0 ||
            shelves.size === 0;

        empty.textContent =
            'ไม่พบแฟ้มตามตัวกรอง ลองเปลี่ยนตัวกรองหรือคำค้นค่ะ';

        if (view === 'shelf') {
            $('bc-count').textContent =
                `แสดง ${visible} จาก ${shelves.size} แฟ้ม`;
            return;
        }

        const searched = groups.filter(group =>
            matches([group.name, group.setCode])
        );

        const near = searched.filter(group =>
            group.total &&
            group.count < group.total &&
            group.percent >= threshold
        ).sort((a, b) =>
            b.percent - a.percent ||
            a.missing.length - b.missing.length ||
            a.name.localeCompare(b.name, 'th')
        );

        const unknown = searched.filter(group => !group.total);

        const completed = searched.filter(group =>
            group.total && group.count === group.total
        ).length;

        $('bc-count').textContent =
            `เข้าเกณฑ์ ${near.length} ชุด` +
            ` · ชุดพื้นฐานครบแล้ว ${completed} ชุด` +
            ` · ข้อมูลไม่พอ ${unknown.length} ชุด`;

        $('bc-results').innerHTML = near.map(group => `
            <article class="bc-card">
                <h3>${esc(group.name)}</h3>

                <p class="bc-note">${esc(label(group))}</p>

                <div class="bc-row">
                    <strong>
                        มี ${group.count}/${group.total} แบบ
                    </strong>
                    <span>
                        ขาด ${group.missing.length} แบบ
                        · ${Math.floor(group.percent)}%
                    </span>
                </div>

                <progress
                    value="${group.count}"
                    max="${group.total}"
                    aria-label="ความคืบหน้าชุดพื้นฐาน ${esc(group.name)}"
                ></progress>

                <details
                    data-key="${esc(group.key)}"
                    ${expanded.has(group.key) ? 'open' : ''}
                >
                    <summary>
                        ดูเลขใบที่ขาด (${group.missing.length})
                    </summary>

                    <p class="bc-numbers">${missingText(group)}</p>

                    <button
                        type="button"
                        class="bc-button"
                        data-copy="${groups.indexOf(group)}"
                    >📋 คัดลอกลิสต์ตามหา</button>
                </details>

                <button
                    type="button"
                    class="bc-button"
                    data-open="${esc(group.name)}"
                >เปิดแฟ้ม →</button>
            </article>
        `).join('') || `
            <p class="bc-note">
                ยังไม่มีชุดที่เข้าเกณฑ์
                ลองลดเปอร์เซ็นต์หรือเปลี่ยนคำค้นค่ะ
            </p>
        `;

        $('bc-unknown').hidden = !unknown.length;

        $('bc-unknown').innerHTML = `
            <summary>
                ชุดที่ยังคำนวณไม่ได้ (${unknown.length})
            </summary>

            ${unknown.map(group => `
                <p>
                    ${esc(group.name)} · ${esc(label(group))}
                    <br>
                    ${esc(group.reason)}
                </p>
            `).join('')}
        `;
    }

    // ===== รับการกดปุ่มและค้นหา =====
    tools.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;

        if (button.dataset.view) {
            view = button.dataset.view;
        }

        if (button.dataset.filter) {
            filter = button.dataset.filter;
        }

        refresh();
    });

    $('bc-search').addEventListener('input', event => {
        query = clean(event.target.value).toLocaleLowerCase();
        refresh();
    });

    $('bc-threshold').addEventListener('change', event => {
        threshold = Number(event.target.value);
        refresh();
    });

    panel.addEventListener('click', async event => {
        const button = event.target.closest('button');
        if (!button) return;

        if (button.dataset.open !== undefined) {
            openBinderFromShelf(button.dataset.open);
            return;
        }

        if (button.dataset.copy === undefined) return;

        const group = groups[Number(button.dataset.copy)];
        if (!group) return;

        const text =
            `🎯 ตามหาการ์ด\n` +
            `Set: ${group.name}\n` +
            `${label(group)}\n` +
            `ขาดชุดพื้นฐาน ${group.missing.length} แบบ\n` +
            `${missingText(group)}\n` +
            `(ไม่รวม Secret และรุ่นฟอยล์ต่าง ๆ)`;

        try {
            await navigator.clipboard.writeText(text);
            showToast('📋 คัดลอกลิสต์ตามหาแล้ว');
        } catch {
            window.prompt(
                'คัดลอกลิสต์ตามหาจากช่องนี้ค่ะ',
                text
            );
        }
    });

    // อัปเดตตัวกรองเมื่อระบบเดิมวาดชั้นวางใหม่
    const previousRender = renderBinderShelf;

    renderBinderShelf = function (...args) {
        const result = previousRender.apply(this, args);
        refresh();
        return result;
    };

    renderBinderShelf();
})();
