(() => {
    'use strict';

    if (document.getElementById('bundle-sale-modal')) return;

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

    const money = value => Number(value).toLocaleString(
        'th-TH',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    );

    let cards = [];
    let saving = false;

    const style = document.createElement('style');

    style.textContent = `
        #bundle-sale-modal {
            border: 0;
            border-radius: 20px;
            padding: 0;
            width: min(620px, 94vw);
            max-height: 90dvh;
            color: #334155;
            background: white;
        }

        #bundle-sale-modal::backdrop {
            background: #0f172a99;
            backdrop-filter: blur(3px);
        }

        #bundle-sale-modal form { padding: 20px; }

        #bundle-sale-modal header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
            margin-bottom: 12px;
        }

        #bundle-sale-modal h2 {
            font-size: 18px;
            font-weight: 800;
            margin: 0;
        }

        #bundle-sale-modal p {
            font-size: 12px;
            color: #64748b;
            margin: 6px 0;
            line-height: 1.6;
        }

        #bundle-sale-modal label {
            display: block;
            font-size: 12px;
            font-weight: 600;
        }

        #bundle-sale-modal input,
        #bundle-sale-modal select {
            width: 100%;
            padding: 10px;
            border: 1px solid #cbd5e1;
            border-radius: 10px;
            font: inherit;
            background: #fff;
            margin-top: 4px;
        }

        #bundle-sale-modal button {
            padding: 9px 12px;
            border-radius: 10px;
            border: 1px solid #cbd5e1;
            cursor: pointer;
        }

        #bundle-sale-modal button:disabled {
            opacity: .5;
            cursor: wait;
        }

        #bundle-sale-modal :focus-visible {
            outline: 3px solid #10b981;
            outline-offset: 2px;
        }

        .bundle-line {
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 12px;
            margin-bottom: 10px;
        }

        .bundle-name {
            font-size: 14px;
            font-weight: 700;
            overflow-wrap: anywhere;
        }

        .bundle-fields {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin: 10px 0;
        }

        #bundle-total {
            font-size: 24px;
            font-weight: 800;
            color: #047857;
        }

        #bundle-sale-modal footer {
            position: sticky;
            bottom: -20px;
            padding: 12px 0;
            background: white;
            border-top: 1px solid #e2e8f0;
            margin-top: 14px;
        }

        #bundle-save {
            width: 100%;
            background: #047857;
            color: white;
            font-weight: 700;
        }

        #bulkActionBar {
            max-width: calc(100vw - 20px);
            width: max-content;
            flex-wrap: wrap;
            justify-content: center;
            gap: 10px;
            border-radius: 16px;
        }

        #bundle-open {
            background: #059669;
            color: #fff;
            padding: 8px 12px;
            border-radius: 10px;
            white-space: nowrap;
            font-size: 12px;
        }
    `;

    document.head.append(style);

    const dialog = document.createElement('dialog');
    dialog.id = 'bundle-sale-modal';
    dialog.setAttribute('aria-labelledby', 'bundle-title');

    dialog.innerHTML = `
        <form id="bundle-form">
            <header>
                <h2 id="bundle-title">🏷️ ขายเหมาหลายใบ</h2>
                <button
                    type="button"
                    id="bundle-close"
                    aria-label="ปิด"
                >✕</button>
            </header>

            <p>
                เลือกจำนวนของแต่ละรายการ
                แล้วกรอกราคาขายรวมทั้งชุดด้านล่าง
            </p>

            <div id="bundle-lines"></div>

            <label>
                ราคาขายเหมาทั้งชุด (บาท)
                <input
                    id="bundle-total"
                    type="number"
                    min="0"
                    max="10000000"
                    step="0.01"
                    required
                    inputmode="decimal"
                    placeholder="เช่น 1000"
                >
            </label>

            <p>
                เฉลี่ยยอดขายตามจำนวนใบเพื่อบันทึกบัญชี
                ยอดรวมยังตรงกับราคาขายเหมา
            </p>

            <div class="bundle-fields">
                <label>
                    ค่าธรรมเนียมทั้งบิล
                    <input
                        id="bundle-fees"
                        type="number"
                        min="0"
                        max="10000000"
                        step="0.01"
                        value="0"
                        required
                        inputmode="decimal"
                    >
                </label>

                <label>
                    ค่าส่งที่เราออกทั้งบิล
                    <input
                        id="bundle-shipping"
                        type="number"
                        min="0"
                        max="10000000"
                        step="0.01"
                        value="0"
                        required
                        inputmode="decimal"
                    >
                </label>
            </div>

            <label>
                สถานะทั้งบิล
                <select id="bundle-status">
                    <option value="pending_payment">รอชำระเงิน</option>
                    <option value="pending_shipping">ชำระแล้ว / รอส่ง</option>
                    <option value="shipped">ส่งแล้ว</option>
                </select>
            </label>

            <label style="margin-top:10px">
                เลขพัสดุ
                <input
                    id="bundle-tracking"
                    maxlength="80"
                    pattern="[A-Za-z0-9 _\\-]*"
                    placeholder="เว้นว่างได้"
                >
            </label>

            <footer>
                <p id="bundle-summary" role="status"></p>
                <button id="bundle-save" type="submit">
                    บันทึกขายทั้งชุด
                </button>
            </footer>
        </form>
    `;

    document.body.append(dialog);

    const openButton = document.createElement('button');
    openButton.id = 'bundle-open';
    openButton.type = 'button';
    openButton.textContent = '🏷️ ขายเหมาที่เลือก';

    $('bulkActionBar')?.append(openButton);

    function open() {
        if (!adminPin) {
            return showToast('กรุณาเข้าสู่ระบบผู้ดูแลก่อน', 'error');
        }

        if (
            typeof TcgTasks === 'undefined' ||
            !TcgTasks.enqueueMutation
        ) {
            return showToast(
                'กรุณาโหลด background-tasks.js ก่อน',
                'error'
            );
        }

        const ids = [...selectedCards].map(String);

        if (!ids.length || ids.length > 100) {
            return showToast(
                'เลือกการ์ด 1–100 รายการก่อนค่ะ',
                'error'
            );
        }

        cards = [];

        for (const id of ids) {
            const matches = allCards.filter(
                card => String(card.id) === id
            );

            if (matches.length !== 1) {
                return showToast(
                    'ไม่พบการ์ด หรือรหัสซ้ำ กรุณารีเฟรชข้อมูล',
                    'error'
                );
            }

            const card = matches[0];
            const stock = Number(card.qty);

            if (
                !Number.isSafeInteger(stock) ||
                stock < 1 ||
                String(card.isWishlist).trim().toLowerCase() === 'true'
            ) {
                return showToast(
                    'นำ ' + card.name +
                    ' ออกจากการเลือกก่อน เพราะไม่มีสต็อกหรือเป็น Wishlist',
                    'error'
                );
            }

            if (!card.recordVersion) {
                return showToast(
                    'กรุณาซิงก์ข้อมูลล่าสุดก่อนเปิดบิล',
                    'error'
                );
            }

            cards.push({ ...card });
        }

        $('bundle-form').reset();

        $('bundle-lines').innerHTML = cards.map((card, index) => `
            <article class="bundle-line">
                <div class="bundle-name">${esc(card.name)}</div>

                <p>
                    ${esc(card.setCode || card.set)}
                    · ${esc(card.cardNumber)}
                    · ${esc(card.language)}
                    · ${esc(card.condition)}
                    ${esc(card.gradeCompany)}
                    ${esc(card.gradeScore)}
                    · คงเหลือ ${Number(card.qty)} ใบ
                </p>

                <div class="bundle-fields">
                    <label>
                        จำนวนที่ขาย
                        <input
                            data-qty="${index}"
                            type="number"
                            min="1"
                            max="${Number(card.qty)}"
                            step="1"
                            value="1"
                            required
                            inputmode="numeric"
                        >
                    </label>

                    <label>
                        ต้นทุนต่อใบ
                        <input
                            data-cost="${index}"
                            type="number"
                            min="0"
                            max="10000000"
                            step="0.01"
                            value="${esc(card.buyPrice ?? '')}"
                            placeholder="ยังไม่ทราบ"
                            inputmode="decimal"
                        >
                    </label>
                </div>
            </article>
        `).join('');

        $('bundle-lines').insertAdjacentHTML(
            'beforeend',
            '<p>การ์ดที่เปิดจากแพ็คและคิดต้นทุนใน Packs แล้ว ' +
            'ให้ใส่ต้นทุนต่อใบเป็น 0 เพื่อไม่หักซ้ำค่ะ</p>'
        );

        preview();
        dialog.showModal();
        $('bundle-total').focus();
    }

    function amount(id) {
        const raw = $(id).value.trim();
        const value = Number(raw);

        if (
            !raw ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 10000000
        ) {
            throw Error(
                'กรอกจำนวนเงินตั้งแต่ 0 ถึง 10,000,000 บาท'
            );
        }

        return Math.round((value + Number.EPSILON) * 100) / 100;
    }

    function items() {
        return cards.map((card, index) => {
            const qty = Number(
                dialog.querySelector(`[data-qty="${index}"]`).value
            );

            const rawCost = dialog.querySelector(
                `[data-cost="${index}"]`
            ).value.trim();

            const unitCost = rawCost === '' ? null : Number(rawCost);

            if (
                !Number.isSafeInteger(qty) ||
                qty < 1 ||
                qty > Number(card.qty)
            ) {
                throw Error('ตรวจจำนวนที่ขายของ ' + card.name);
            }

            if (
                unitCost !== null &&
                (
                    !Number.isFinite(unitCost) ||
                    unitCost < 0 ||
                    unitCost > 10000000
                )
            ) {
                throw Error('ตรวจต้นทุนของ ' + card.name);
            }

            return {
                id: String(card.id),
                qty,
                unitCost,
                expectedVersion: card.recordVersion
            };
        });
    }

    function preview() {
        try {
            const lines = items();
            const qty = lines.reduce(
                (sum, line) => sum + line.qty, 0
            );

            if (qty > 10000) {
                throw Error('รองรับไม่เกิน 10,000 ใบต่อบิล');
            }

            const total = amount('bundle-total');
            const fees = amount('bundle-fees');
            const shipping = amount('bundle-shipping');

            const known = lines.every(
                line => line.unitCost !== null
            );

            const cost = lines.reduce(
                (sum, line) =>
                    sum +
                    Math.round((line.unitCost || 0) * 100) * line.qty,
                0
            );

            const profit = (
                Math.round(total * 100) -
                Math.round(fees * 100) -
                Math.round(shipping * 100) -
                cost
            ) / 100;

            $('bundle-summary').textContent =
                `${lines.length} รายการ · ${qty} ใบ` +
                ` · ขายเหมา ฿${money(total)} · ` +
                (
                    known
                        ? `กำไรบิล ฿${money(profit)} (ก่อนหักต้นทุนแพ็ค)`
                        : 'กำไรยังไม่ครบ เพราะบางรายการไม่ระบุต้นทุน'
                );

        } catch (error) {
            $('bundle-summary').textContent = error.message;
        }
    }

    openButton.addEventListener('click', open);

    $('bundle-close').addEventListener('click', () => {
        if (!saving) dialog.close();
    });

    dialog.addEventListener('cancel', event => {
        if (saving) event.preventDefault();
    });

    $('bundle-form').addEventListener('input', preview);

    $('bundle-form').addEventListener('submit', async event => {
        event.preventDefault();

        if (saving || !event.target.reportValidity()) return;

        const controls = [
            ...dialog.querySelectorAll('button,input,select')
        ];

        try {
            const lines = items();
            const qty = lines.reduce(
                (sum, line) => sum + line.qty, 0
            );

            if (qty > 10000) {
                throw Error('รองรับไม่เกิน 10,000 ใบต่อบิล');
            }

            const payload = {
                action: 'sellBundle',
                name: `ขายเหมา ${qty} ใบ`,
                items: lines,
                bundleTotal: amount('bundle-total'),
                fees: amount('bundle-fees'),
                shippingCost: amount('bundle-shipping'),
                deliveryStatus: $('bundle-status').value,
                trackingNumber: $('bundle-tracking').value.trim()
            };

            saving = true;
            controls.forEach(control => control.disabled = true);

            $('bundle-save').textContent = 'กำลังเก็บบิลเข้าคิว…';

            await TcgTasks.enqueueMutation(payload);

            dialog.close();

            if (isSelectMode) toggleSelectMode();

            showToast(
                '☁️ รับบิลขายเหมาเข้าคิวแล้ว ดูผลบันทึกที่แถบงานค่ะ'
            );

        } catch (error) {
            showToast(error.message, 'error');

        } finally {
            saving = false;
            controls.forEach(control => control.disabled = false);
            $('bundle-save').textContent = 'บันทึกขายทั้งชุด';
        }
    });
})();
