"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const multer_1 = __importDefault(require("multer"));
const xlsx = __importStar(require("xlsx"));
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// GET all customers
router.get('/', async (req, res) => {
    try {
        const customers = await prisma.customer.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(customers);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});
// POST new customer
router.post('/', async (req, res) => {
    try {
        const { name, contact, email } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const customer = await prisma.customer.create({
            data: { name, contact, email }
        });
        res.status(201).json(customer);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create customer' });
    }
});
// PUT update customer
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, contact, email, status } = req.body;
        if (!name && !status)
            return res.status(400).json({ error: 'Data is required to update' });
        const updateData = {};
        if (name)
            updateData.name = name;
        if (contact !== undefined)
            updateData.contact = contact;
        if (email !== undefined)
            updateData.email = email;
        if (status)
            updateData.status = status;
        const customer = await prisma.customer.update({
            where: { id },
            data: updateData
        });
        res.json(customer);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update customer' });
    }
});
// DELETE customer
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.customer.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete customer' });
    }
});
// POST bulk upload customers
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);
        let successCount = 0;
        const errors = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            try {
                if (!row.name) {
                    errors.push(`Row ${i + 2}: Missing name`);
                    continue;
                }
                await prisma.customer.create({
                    data: {
                        name: row.name,
                        contact: row.contact ? String(row.contact) : null,
                        email: row.email ? String(row.email) : null
                    }
                });
                successCount++;
            }
            catch (err) {
                errors.push(`Row ${i + 2}: ${err.message}`);
            }
        }
        res.json({ message: `Successfully processed ${successCount} rows.`, errors });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to process bulk upload' });
    }
});
exports.default = router;
