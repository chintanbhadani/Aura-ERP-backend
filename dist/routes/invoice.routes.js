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
        const invoices = await prisma.invoice.findMany({
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
        res.json(invoices);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch invoices' });
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
        res.json(invoice);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch invoice' });
    }
});
// POST create new invoice
router.post('/', async (req, res) => {
    try {
        const { type, date, customerId, supplierId, items } = req.body;
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
        // Use a transaction to ensure all operations succeed or fail together
        const result = await prisma.$transaction(async (tx) => {
            // 1. Create Invoice and Items
            const invoice = await tx.invoice.create({
                data: {
                    invoiceNumber,
                    type,
                    date: new Date(date || Date.now()),
                    totalAmount,
                    customerId: type === 'SALES' ? customerId : null,
                    supplierId: type === 'PURCHASE' ? supplierId : null,
                    items: {
                        create: items.map((item) => ({
                            productId: item.productId,
                            quantity: Number(item.quantity),
                            unitPrice: Number(item.unitPrice),
                            totalPrice: Number(item.quantity) * Number(item.unitPrice),
                        })),
                    },
                },
                include: {
                    items: true,
                },
            });
            // 2. Update Inventory
            for (const item of items) {
                const product = await tx.product.findUnique({
                    where: { id: item.productId },
                });
                if (!product) {
                    throw new Error(`Product with ID ${item.productId} not found`);
                }
                const quantityChange = type === 'PURCHASE' ? Number(item.quantity) : -Number(item.quantity);
                const newQuantity = product.quantity + quantityChange;
                // Optionally prevent negative inventory for sales
                // if (type === 'SALES' && newQuantity < 0) {
                //   throw new Error(`Insufficient inventory for product ${product.name}`);
                // }
                await tx.product.update({
                    where: { id: item.productId },
                    data: { quantity: newQuantity },
                });
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
exports.default = router;
