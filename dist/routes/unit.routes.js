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
// GET all units
router.get('/', async (req, res) => {
    try {
        const { search, status } = req.query;
        const units = await prisma.unit.findMany({
            where: {
                AND: [
                    search ? { name: { contains: search, mode: 'insensitive' } } : {},
                    status && status !== 'ALL' ? { status: status } : {}
                ]
            },
            orderBy: { name: 'asc' }
        });
        res.json(units);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch units' });
    }
});
// POST new unit
router.post('/', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const unit = await prisma.unit.create({
            data: { name }
        });
        res.status(201).json(unit);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create unit' });
    }
});
// PUT update unit
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status } = req.body;
        if (!name && !status)
            return res.status(400).json({ error: 'Data is required to update' });
        const updateData = {};
        if (name)
            updateData.name = name;
        if (status)
            updateData.status = status;
        const unit = await prisma.unit.update({
            where: { id },
            data: updateData
        });
        res.json(unit);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update unit' });
    }
});
// DELETE unit
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.unit.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete unit' });
    }
});
// POST bulk upload units
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
                await prisma.unit.create({
                    data: { name: row.name }
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
