"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// Utility to generate invoice number
const generateInvoiceNumber = async (type) => {
    const year = new Date().getFullYear();
    const typeChar = type === 'PURCHASE' ? 'P' : 'S';
    const prefix = `INV-${year}-${typeChar}`;
    const lastInvoice = await prisma.invoice.findFirst({
        where: {
            invoiceNumber: {
                startsWith: prefix,
            },
        },
        orderBy: {
            invoiceNumber: 'desc',
        },
    });
    if (!lastInvoice) {
        return `${prefix}0001`;
    }
    // Extract the number part
    const lastNumberStr = lastInvoice.invoiceNumber.replace(prefix, '');
    const nextNumber = parseInt(lastNumberStr, 10) + 1;
    const paddedNumber = nextNumber.toString().padStart(4, '0');
    return `${prefix}${paddedNumber}`;
};
// GET all invoices
router.get('/', async (req, res) => {
    try {
        const { search, type } = req.query;
        const invoices = await prisma.invoice.findMany({
            where: {
                AND: [
                    search ? { invoiceNumber: { contains: search, mode: 'insensitive' } } : {},
                    type && type !== 'ALL' ? { type: type } : {}
                ]
            },
            orderBy: { createdAt: 'desc' },
            include: {
                customer: true,
                supplier: true,
                items: {
                    include: {
                        product: true,
                    }
                }
            },
        });
        const formatted = invoices.map((inv) => ({
            ...inv,
            client: inv.customer ? { ...inv.customer, companyName: inv.customer.name } : null,
        }));
        res.json(formatted);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch invoices' });
    }
});
// GET available purchase batches / PO lots for a specific product
router.get('/available-batches/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const product = await prisma.product.findUnique({
            where: { id: productId },
        });
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        // 1. Fetch all purchase items for this product
        const purchaseItems = await prisma.invoiceItem.findMany({
            where: {
                productId,
                invoice: {
                    type: 'PURCHASE',
                },
            },
            include: {
                invoice: {
                    include: {
                        supplier: true,
                    },
                },
            },
            orderBy: {
                invoice: {
                    date: 'asc',
                },
            },
        });
        // 2. Fetch all sales items linked to any purchase item of this product
        const salesItems = await prisma.invoiceItem.findMany({
            where: {
                productId,
                invoice: {
                    type: 'SALES',
                },
                OR: [
                    { purchaseItemId: { not: null } },
                    { poAllocations: { not: client_1.Prisma.JsonNull } },
                ],
            },
            select: {
                purchaseItemId: true,
                quantity: true,
                poAllocations: true,
            },
        });
        const soldQtyByPurchaseItem = new Map();
        for (const s of salesItems) {
            if (Array.isArray(s.poAllocations) && s.poAllocations.length > 0) {
                for (const alloc of s.poAllocations) {
                    if (alloc.purchaseItemId && alloc.quantity) {
                        soldQtyByPurchaseItem.set(alloc.purchaseItemId, (soldQtyByPurchaseItem.get(alloc.purchaseItemId) || 0) + Number(alloc.quantity));
                    }
                }
            }
            else if (s.purchaseItemId) {
                soldQtyByPurchaseItem.set(s.purchaseItemId, (soldQtyByPurchaseItem.get(s.purchaseItemId) || 0) + s.quantity);
            }
        }
        const batches = [];
        // Add batches from purchase invoices
        for (const pi of purchaseItems) {
            const sold = soldQtyByPurchaseItem.get(pi.id) || 0;
            const available = pi.quantity - sold;
            if (available > 0) {
                batches.push({
                    purchaseItemId: pi.id,
                    poNumber: pi.invoice.invoiceNumber,
                    date: pi.invoice.date,
                    supplierName: pi.invoice.supplier?.name || 'Direct Purchase',
                    unitCost: Number(pi.unitPrice),
                    initialQuantity: pi.quantity,
                    availableQuantity: available,
                });
            }
        }
        // Only fallback to INITIAL-STOCK if NO purchase invoice/PO has ever been created for this product
        if (purchaseItems.length === 0 && product.quantity > 0) {
            batches.unshift({
                purchaseItemId: 'INITIAL',
                poNumber: 'INITIAL-STOCK',
                date: product.createdAt,
                supplierName: 'Opening Stock',
                unitCost: Number(product.cost_price),
                initialQuantity: product.quantity,
                availableQuantity: product.quantity,
            });
        }
        res.json({
            productId: product.id,
            productName: product.name,
            sku: product.sku,
            totalStock: product.quantity,
            defaultSellingPrice: Number(product.selling_price),
            batches,
        });
    }
    catch (error) {
        console.error('Error fetching available batches:', error);
        res.status(500).json({ error: error.message || 'Failed to fetch available batches' });
    }
});
// GET single invoice by id
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const invoice = await prisma.invoice.findUnique({
            where: { id },
            include: {
                customer: true,
                supplier: true,
                items: {
                    include: {
                        product: true,
                    },
                },
            },
        });
        if (!invoice)
            return res.status(404).json({ error: 'Invoice not found' });
        const formatted = {
            ...invoice,
            client: invoice.customer ? { ...invoice.customer, companyName: invoice.customer.name } : null,
        };
        res.json(formatted);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});
// POST create new invoice
router.post('/', async (req, res) => {
    try {
        const { type, date, customerId, supplierId, items, paymentType, cashAmount, bankAmount, creditAmount, mobileMoneyAmount } = req.body;
        if (!type || !items || !items.length) {
            return res.status(400).json({ error: 'Type and items are required' });
        }
        if (type === 'SALES' && !customerId) {
            return res.status(400).json({ error: 'Customer is required for sales invoice' });
        }
        if (type === 'PURCHASE' && !supplierId) {
            return res.status(400).json({ error: 'Supplier is required for purchase invoice' });
        }
        const totalAmount = items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
        const invoiceNumber = await generateInvoiceNumber(type);
        const invoiceDate = new Date(date || Date.now());
        // Use a transaction to ensure all operations succeed or fail together
        const result = await prisma.$transaction(async (tx) => {
            // 1. Verify chronological stock (The "Future-Dip" check)
            for (const item of items) {
                const quantityChange = type === 'PURCHASE' ? Number(item.quantity) : -Number(item.quantity);
                if (type === 'SALES') {
                    // Check stock point-in-time and future
                    const minBalanceResult = await tx.$queryRaw `
            WITH proposed_ledger AS (
                SELECT date, "quantityChange"
                FROM "StockLedger"
                WHERE "productId" = ${item.productId}
                
                UNION ALL
                
                SELECT ${invoiceDate}::TIMESTAMP, ${quantityChange}::INTEGER
            ),
            cumulative_calculation AS (
                SELECT 
                    date,
                    SUM("quantityChange") OVER (ORDER BY date ASC) AS cumulative_balance
                FROM proposed_ledger
            )
            SELECT MIN(cumulative_balance) AS min_future_balance
            FROM cumulative_calculation
            WHERE date >= ${invoiceDate}::TIMESTAMP;
          `;
                    const rawMin = minBalanceResult[0]?.min_future_balance;
                    const minFutureBalance = rawMin !== undefined && rawMin !== null ? Number(rawMin) : quantityChange;
                    if (minFutureBalance < 0) {
                        throw new Error(`Insufficient stock for product. Backdating this sale causes inventory to drop below zero (Dip: ${minFutureBalance}) on or after ${invoiceDate.toISOString()}.`);
                    }
                }
            }
            const finalCashAmount = cashAmount !== undefined ? Number(cashAmount) : (paymentType === 'CASH' ? totalAmount : 0);
            const finalBankAmount = bankAmount !== undefined ? Number(bankAmount) : (paymentType === 'BANK' ? totalAmount : 0);
            const finalCreditAmount = creditAmount !== undefined ? Number(creditAmount) : (paymentType === 'CREDIT' ? totalAmount : 0);
            const finalMobileMoneyAmount = mobileMoneyAmount !== undefined ? Number(mobileMoneyAmount) : (paymentType === 'MOBILE_MONEY' ? totalAmount : 0);
            // 2. Create Invoice and Items
            const invoice = await tx.invoice.create({
                data: {
                    invoiceNumber,
                    type,
                    date: invoiceDate,
                    totalAmount,
                    customerId: type === 'SALES' ? customerId : null,
                    supplierId: type === 'PURCHASE' ? supplierId : null,
                    paymentType: paymentType || 'CASH',
                    cashAmount: finalCashAmount,
                    bankAmount: finalBankAmount,
                    creditAmount: finalCreditAmount,
                    mobileMoneyAmount: finalMobileMoneyAmount,
                    items: {
                        create: items.map((item) => ({
                            productId: item.productId,
                            quantity: Number(item.quantity),
                            unitPrice: Number(item.unitPrice),
                            totalPrice: Number(item.quantity) * Number(item.unitPrice),
                            costPrice: item.costPrice !== undefined && item.costPrice !== null ? Number(item.costPrice) : null,
                            purchaseInvoiceNo: item.purchaseInvoiceNo || null,
                            purchaseItemId: item.purchaseItemId || null,
                            poAllocations: item.poAllocations || null,
                        })),
                    },
                },
                include: {
                    items: true,
                },
            });
            // 3. Update Inventory and Ledger
            for (const item of items) {
                const product = await tx.product.findUnique({
                    where: { id: item.productId },
                });
                if (!product) {
                    throw new Error(`Product with ID ${item.productId} not found`);
                }
                const quantityChange = type === 'PURCHASE' ? Number(item.quantity) : -Number(item.quantity);
                // Calculate the specific running balance for THIS new row based on past ledger entries
                const currentBalanceResult = await tx.$queryRaw `
          SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
          FROM "StockLedger"
          WHERE "productId" = ${item.productId}
            AND date < ${invoiceDate}::TIMESTAMP
        `;
                const balanceBefore = currentBalanceResult[0]?.balance_before ? Number(currentBalanceResult[0].balance_before) : 0;
                const newRunningBalance = balanceBefore + quantityChange;
                // Insert into ledger
                await tx.stockLedger.create({
                    data: {
                        productId: item.productId,
                        date: invoiceDate,
                        type: type,
                        quantityChange: quantityChange,
                        runningBalance: newRunningBalance,
                        invoiceId: invoice.id,
                    }
                });
                // Forward Recalculation for future ledger entries if this was backdated
                await tx.$queryRaw `
            UPDATE "StockLedger"
            SET "runningBalance" = "runningBalance" + ${quantityChange}
            WHERE "productId" = ${item.productId}
              AND date > ${invoiceDate}::TIMESTAMP
        `;
                // Update the cached quantity on the product
                const newProductQuantity = product.quantity + quantityChange;
                await tx.product.update({
                    where: { id: item.productId },
                    data: { quantity: newProductQuantity },
                });
            }
            // 4. Update Cash Ledger
            if (finalCashAmount > 0) {
                const cashQuantityChange = type === 'SALES' ? finalCashAmount : -finalCashAmount;
                const currentCashBalanceResult = await tx.$queryRaw `
          SELECT COALESCE(SUM("amountChange"), 0) AS balance_before
          FROM "CashLedger"
          WHERE "paymentType" = 'CASH'
            AND date < ${invoiceDate}::TIMESTAMP
        `;
                const cashBalanceBefore = currentCashBalanceResult[0]?.balance_before ? Number(currentCashBalanceResult[0].balance_before) : 0;
                const newCashRunningBalance = cashBalanceBefore + cashQuantityChange;
                await tx.cashLedger.create({
                    data: {
                        date: invoiceDate,
                        paymentType: 'CASH',
                        sourceType: type === 'SALES' ? 'SALE' : 'PURCHASE',
                        amountChange: cashQuantityChange,
                        runningBalance: newCashRunningBalance,
                        invoiceId: invoice.id,
                    }
                });
                await tx.$queryRaw `
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${cashQuantityChange}
            WHERE "paymentType" = 'CASH'
              AND date > ${invoiceDate}::TIMESTAMP
        `;
            }
            if (finalBankAmount > 0) {
                const bankQuantityChange = type === 'SALES' ? finalBankAmount : -finalBankAmount;
                const currentBankBalanceResult = await tx.$queryRaw `
          SELECT COALESCE(SUM("amountChange"), 0) AS balance_before
          FROM "CashLedger"
          WHERE "paymentType" = 'BANK'
            AND date < ${invoiceDate}::TIMESTAMP
        `;
                const bankBalanceBefore = currentBankBalanceResult[0]?.balance_before ? Number(currentBankBalanceResult[0].balance_before) : 0;
                const newBankRunningBalance = bankBalanceBefore + bankQuantityChange;
                await tx.cashLedger.create({
                    data: {
                        date: invoiceDate,
                        paymentType: 'BANK',
                        sourceType: type === 'SALES' ? 'SALE' : 'PURCHASE',
                        amountChange: bankQuantityChange,
                        runningBalance: newBankRunningBalance,
                        invoiceId: invoice.id,
                    }
                });
                await tx.$queryRaw `
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${bankQuantityChange}
            WHERE "paymentType" = 'BANK'
              AND date > ${invoiceDate}::TIMESTAMP
        `;
            }
            return invoice;
        });
        res.status(201).json(result);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'Failed to create invoice' });
    }
});
// DELETE invoice by id
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.$transaction(async (tx) => {
            await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
            await tx.stockLedger.deleteMany({ where: { invoiceId: id } });
            await tx.cashLedger.deleteMany({ where: { invoiceId: id } });
            await tx.invoice.delete({ where: { id } });
        });
        res.json({ message: 'Invoice deleted successfully' });
    }
    catch (error) {
        res.status(500).json({ error: error.message || 'Failed to delete invoice' });
    }
});
exports.default = router;
