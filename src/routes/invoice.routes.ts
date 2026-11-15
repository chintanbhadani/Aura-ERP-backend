import { Router, Request, Response } from 'express';
import { PrismaClient, InvoiceType, PaymentType, Prisma } from '@prisma/client';
import multer from 'multer';
import * as xlsx from 'xlsx';

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();
const prisma = new PrismaClient();

// Utility to generate invoice number
const generateInvoiceNumber = async (type: InvoiceType) => {
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
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, type } = req.query;

    const invoices = await prisma.invoice.findMany({
      where: {
        AND: [
          search ? { invoiceNumber: { contains: search as string, mode: 'insensitive' } } : {},
          type && type !== 'ALL' ? { type: type as any } : {}
        ]
      },
      orderBy: { updatedAt: 'desc' },
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
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

// GET available purchase batches / PO lots for a specific product
router.get('/available-batches/:productId', async (req: Request, res: Response) => {
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
          { poAllocations: { not: Prisma.JsonNull } },
        ],
      },
      select: {
        purchaseItemId: true,
        quantity: true,
        poAllocations: true,
      },
    });

    const soldQtyByPurchaseItem = new Map<string, number>();
    for (const s of salesItems) {
      if (Array.isArray(s.poAllocations) && s.poAllocations.length > 0) {
        for (const alloc of s.poAllocations as any[]) {
          if (alloc.purchaseItemId && alloc.quantity) {
            soldQtyByPurchaseItem.set(
              alloc.purchaseItemId,
              (soldQtyByPurchaseItem.get(alloc.purchaseItemId) || 0) + Number(alloc.quantity)
            );
          }
        }
      } else if (s.purchaseItemId) {
        soldQtyByPurchaseItem.set(
          s.purchaseItemId,
          (soldQtyByPurchaseItem.get(s.purchaseItemId) || 0) + s.quantity
        );
      }
    }

    // Also deduct quantities consumed by repacking from this purchase batch
    try {
      const repacks = await prisma.repackEntry.findMany({
        where: {
          sourceProductId: productId,
          purchaseItemId: { not: null },
        },
        select: {
          purchaseItemId: true,
          sourceQuantity: true,
        },
      });

      for (const r of repacks) {
        if (r.purchaseItemId) {
          soldQtyByPurchaseItem.set(
            r.purchaseItemId,
            (soldQtyByPurchaseItem.get(r.purchaseItemId) || 0) + Number(r.sourceQuantity)
          );
        }
      }
    } catch (repackErr) {
      // ignore if RepackEntry table not yet loaded
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
  } catch (error: any) {
    console.error('Error fetching available batches:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch available batches' });
  }
});

// GET single invoice by id
router.get('/:id', async (req: Request, res: Response) => {
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
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const formatted = {
      ...invoice,
      client: invoice.customer ? { ...invoice.customer, companyName: invoice.customer.name } : null,
    };
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST create new invoice
router.post('/', async (req: Request, res: Response) => {
  try {
    const { type, date, dueDate, notes, paymentTerms, customerId, supplierId, items, paymentType, cashAmount, bankAmount, creditAmount, mobileMoneyAmount, imageUrl, attachments } = req.body;

    if (!type || !items || !items.length) {
      return res.status(400).json({ error: 'Type and items are required' });
    }

    if (type === 'SALES' && !customerId) {
      return res.status(400).json({ error: 'Customer is required for sales invoice' });
    }

    if (type === 'PURCHASE' && !supplierId) {
      return res.status(400).json({ error: 'Supplier is required for purchase invoice' });
    }

    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.quantity) * Number(item.unitPrice),
      0
    );

    const invoiceNumber = await generateInvoiceNumber(type as InvoiceType);

    const invoiceDate = new Date(date || Date.now());

    // Use a transaction to ensure all operations succeed or fail together
    const result = await prisma.$transaction(async (tx) => {
      // 1. Verify chronological stock (The "Future-Dip" check)
      for (const item of items) {
        const quantityChange = type === 'PURCHASE' ? Number(item.quantity) : -Number(item.quantity);
        
        // Ensure opening/initial stock is recorded in StockLedger if product has positive quantity but missing ledger entries
        const currentProduct = await tx.product.findUnique({ where: { id: item.productId } });
        if (currentProduct && currentProduct.quantity > 0) {
          const ledgerAgg = await tx.stockLedger.aggregate({
            where: { productId: item.productId },
            _sum: { quantityChange: true },
          });
          const ledgerSum = ledgerAgg._sum.quantityChange || 0;
          const diff = currentProduct.quantity - ledgerSum;
          if (diff > 0) {
            const initialDate = currentProduct.createdAt || new Date('2020-01-01');
            await tx.stockLedger.create({
              data: {
                productId: item.productId,
                date: initialDate,
                type: 'INITIAL',
                quantityChange: diff,
                runningBalance: diff,
                createdAt: initialDate,
              },
            });
            await tx.$executeRaw`
              UPDATE "StockLedger"
              SET "runningBalance" = "runningBalance" + ${diff}
              WHERE "productId" = ${item.productId}
                AND date > ${initialDate}::TIMESTAMP
            `;
          }
        }

        if (type === 'SALES') {
          // Check stock point-in-time and future
          const minBalanceResult: any = await tx.$queryRaw`
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
          const minFutureBalance =
            rawMin !== undefined && rawMin !== null ? Number(rawMin) : quantityChange;
          
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
          dueDate: dueDate ? new Date(dueDate) : null,
          notes: notes || null,
          paymentTerms: paymentTerms || null,
          totalAmount,
          customerId: type === 'SALES' ? customerId : null,
          supplierId: type === 'PURCHASE' ? supplierId : null,
          paymentType: paymentType || 'CASH',
          cashAmount: finalCashAmount,
          bankAmount: finalBankAmount,
          creditAmount: finalCreditAmount,
          mobileMoneyAmount: finalMobileMoneyAmount,
          imageUrl: imageUrl || null,
          attachments: attachments || null,
          items: {
            create: items.map((item: any) => ({
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
        const currentBalanceResult: any = await tx.$queryRaw`
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
        await tx.$queryRaw`
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
        
        const currentCashBalanceResult: any = await tx.$queryRaw`
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

        await tx.$queryRaw`
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${cashQuantityChange}
            WHERE "paymentType" = 'CASH'
              AND date > ${invoiceDate}::TIMESTAMP
        `;
      }

      if (finalBankAmount > 0) {
        const bankQuantityChange = type === 'SALES' ? finalBankAmount : -finalBankAmount;
        
        const currentBankBalanceResult: any = await tx.$queryRaw`
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

        await tx.$queryRaw`
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${bankQuantityChange}
            WHERE "paymentType" = 'BANK'
              AND date > ${invoiceDate}::TIMESTAMP
        `;
      }

      if (finalMobileMoneyAmount > 0) {
        const mmQuantityChange = type === 'SALES' ? finalMobileMoneyAmount : -finalMobileMoneyAmount;
        
        const currentMMBalanceResult: any = await tx.$queryRaw`
          SELECT COALESCE(SUM("amountChange"), 0) AS balance_before
          FROM "CashLedger"
          WHERE "paymentType" = 'MOBILE_MONEY'
            AND date < ${invoiceDate}::TIMESTAMP
        `;
        const mmBalanceBefore = currentMMBalanceResult[0]?.balance_before ? Number(currentMMBalanceResult[0].balance_before) : 0;
        const newMMRunningBalance = mmBalanceBefore + mmQuantityChange;

        await tx.cashLedger.create({
          data: {
            date: invoiceDate,
            paymentType: 'MOBILE_MONEY',
            sourceType: type === 'SALES' ? 'SALE' : 'PURCHASE',
            amountChange: mmQuantityChange,
            runningBalance: newMMRunningBalance,
            invoiceId: invoice.id,
          }
        });

        await tx.$queryRaw`
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${mmQuantityChange}
            WHERE "paymentType" = 'MOBILE_MONEY'
              AND date > ${invoiceDate}::TIMESTAMP
        `;
      }

      return invoice;
    });

    res.status(201).json(result);
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Failed to create invoice' });
  }
});

// PUT update invoice by id
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      type,
      date,
      dueDate,
      notes,
      paymentTerms,
      customerId,
      supplierId,
      items,
      paymentType,
      cashAmount,
      bankAmount,
      creditAmount,
      mobileMoneyAmount,
      imageUrl,
      attachments
    } = req.body;

    const existingInvoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        items: true,
      }
    });

    if (!existingInvoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    if (!type || !items || !items.length) {
      return res.status(400).json({ error: 'Type and items are required' });
    }

    const effectiveCustomerId = customerId || req.body.clientId;
    const effectiveSupplierId = supplierId;

    if (type === 'SALES' && !effectiveCustomerId) {
      return res.status(400).json({ error: 'Customer is required for sales invoice' });
    }

    if (type === 'PURCHASE' && !effectiveSupplierId) {
      return res.status(400).json({ error: 'Supplier is required for purchase invoice' });
    }

    const totalAmount = items.reduce(
      (sum: number, item: any) => sum + Number(item.quantity) * Number(item.unitPrice),
      0
    );

    const invoiceDate = new Date(date || existingInvoice.date);

    const result = await prisma.$transaction(async (tx) => {
      // 1. REVERT PREVIOUS STOCK
      for (const oldItem of existingInvoice.items) {
        if (!oldItem.productId) continue;
        const oldQty = Math.round(Number(oldItem.quantity));
        const revertQty = existingInvoice.type === 'PURCHASE' ? -oldQty : oldQty;

        await tx.product.update({
          where: { id: oldItem.productId },
          data: { quantity: { increment: revertQty } }
        });

        await tx.$queryRaw`
          UPDATE "StockLedger"
          SET "runningBalance" = "runningBalance" + ${revertQty}
          WHERE "productId" = ${oldItem.productId}
            AND date > ${existingInvoice.date}::TIMESTAMP
        `;
      }

      // 2. REVERT PREVIOUS CASH LEDGER
      const oldCashLedgers = await tx.cashLedger.findMany({ where: { invoiceId: id } });
      for (const cl of oldCashLedgers) {
        const revertCash = -Number(cl.amountChange);
        await tx.$queryRaw`
          UPDATE "CashLedger"
          SET "runningBalance" = "runningBalance" + ${revertCash}
          WHERE "paymentType" = ${cl.paymentType}::"PaymentType"
            AND date > ${cl.date}::TIMESTAMP
        `;
      }

      // Delete old ledger entries & line items for this invoice
      await tx.stockLedger.deleteMany({ where: { invoiceId: id } });
      await tx.cashLedger.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });

      // 3. CHECK POINT-IN-TIME STOCK IF SALES INVOICE
      for (const item of items) {
        if (type === 'SALES') {
          const currentProduct = await tx.product.findUnique({ where: { id: item.productId } });
          const totalRequestedQty = items
            .filter((i: any) => i.productId === item.productId)
            .reduce((sum: number, i: any) => sum + Number(i.quantity), 0);

          if (!currentProduct || currentProduct.quantity < totalRequestedQty) {
            throw new Error(`Insufficient stock for product "${currentProduct?.name || item.productId}". Available: ${currentProduct?.quantity || 0}, requested: ${totalRequestedQty}`);
          }
        }
      }

      const finalCashAmount = cashAmount !== undefined ? Number(cashAmount) : (paymentType === 'CASH' ? totalAmount : 0);
      const finalBankAmount = bankAmount !== undefined ? Number(bankAmount) : (paymentType === 'BANK' ? totalAmount : 0);
      const finalCreditAmount = creditAmount !== undefined ? Number(creditAmount) : (paymentType === 'CREDIT' ? totalAmount : 0);
      const finalMobileMoneyAmount = mobileMoneyAmount !== undefined ? Number(mobileMoneyAmount) : (paymentType === 'MOBILE_MONEY' ? totalAmount : 0);

      // 4. UPDATE INVOICE RECORD
      const updatedInvoice = await tx.invoice.update({
        where: { id },
        data: {
          type,
          date: invoiceDate,
          dueDate: dueDate ? new Date(dueDate) : null,
          notes: notes || null,
          paymentTerms: paymentTerms || null,
          totalAmount,
          customerId: type === 'SALES' ? effectiveCustomerId : null,
          supplierId: type === 'PURCHASE' ? effectiveSupplierId : null,
          paymentType: paymentType || 'CASH',
          cashAmount: finalCashAmount,
          bankAmount: finalBankAmount,
          creditAmount: finalCreditAmount,
          mobileMoneyAmount: finalMobileMoneyAmount,
          imageUrl: imageUrl !== undefined ? (imageUrl || null) : existingInvoice.imageUrl,
          attachments: attachments !== undefined ? (attachments || null) : (existingInvoice.attachments as any),
          items: {
            create: items.map((item: any) => ({
              productId: item.productId,
              quantity: Math.round(Number(item.quantity)),
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

      // 5. APPLY NEW INVENTORY & STOCK LEDGER
      for (const item of items) {
        const product = await tx.product.findUnique({ where: { id: item.productId } });
        if (!product) throw new Error(`Product with ID ${item.productId} not found`);

        const itemQty = Math.round(Number(item.quantity));
        const quantityChange = type === 'PURCHASE' ? itemQty : -itemQty;

        const currentBalanceResult: any = await tx.$queryRaw`
          SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
          FROM "StockLedger"
          WHERE "productId" = ${item.productId}
            AND date < ${invoiceDate}::TIMESTAMP
        `;
        const balanceBefore = currentBalanceResult[0]?.balance_before ? Number(currentBalanceResult[0].balance_before) : 0;
        const newRunningBalance = balanceBefore + quantityChange;

        await tx.stockLedger.create({
          data: {
            productId: item.productId,
            date: invoiceDate,
            type: type,
            quantityChange,
            runningBalance: newRunningBalance,
            invoiceId: id,
          }
        });

        await tx.$queryRaw`
          UPDATE "StockLedger"
          SET "runningBalance" = "runningBalance" + ${quantityChange}
          WHERE "productId" = ${item.productId}
            AND date > ${invoiceDate}::TIMESTAMP
        `;

        await tx.product.update({
          where: { id: item.productId },
          data: { quantity: { increment: quantityChange } }
        });
      }

      // 6. APPLY NEW CASH LEDGER
      if (finalCashAmount > 0) {
        const cashQuantityChange = type === 'SALES' ? finalCashAmount : -finalCashAmount;
        const currentCashBalanceResult: any = await tx.$queryRaw`
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
            invoiceId: id,
          }
        });

        await tx.$queryRaw`
          UPDATE "CashLedger"
          SET "runningBalance" = "runningBalance" + ${cashQuantityChange}
          WHERE "paymentType" = 'CASH'
            AND date > ${invoiceDate}::TIMESTAMP
        `;
      }

      if (finalBankAmount > 0) {
        const bankQuantityChange = type === 'SALES' ? finalBankAmount : -finalBankAmount;
        const currentBankBalanceResult: any = await tx.$queryRaw`
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
            invoiceId: id,
          }
        });

        await tx.$queryRaw`
          UPDATE "CashLedger"
          SET "runningBalance" = "runningBalance" + ${bankQuantityChange}
          WHERE "paymentType" = 'BANK'
            AND date > ${invoiceDate}::TIMESTAMP
        `;
      }

      if (finalMobileMoneyAmount > 0) {
        const mmQuantityChange = type === 'SALES' ? finalMobileMoneyAmount : -finalMobileMoneyAmount;
        const currentMMBalanceResult: any = await tx.$queryRaw`
          SELECT COALESCE(SUM("amountChange"), 0) AS balance_before
          FROM "CashLedger"
          WHERE "paymentType" = 'MOBILE_MONEY'
            AND date < ${invoiceDate}::TIMESTAMP
        `;
        const mmBalanceBefore = currentMMBalanceResult[0]?.balance_before ? Number(currentMMBalanceResult[0].balance_before) : 0;
        const newMMRunningBalance = mmBalanceBefore + mmQuantityChange;

        await tx.cashLedger.create({
          data: {
            date: invoiceDate,
            paymentType: 'MOBILE_MONEY',
            sourceType: type === 'SALES' ? 'SALE' : 'PURCHASE',
            amountChange: mmQuantityChange,
            runningBalance: newMMRunningBalance,
            invoiceId: id,
          }
        });

        await tx.$queryRaw`
          UPDATE "CashLedger"
          SET "runningBalance" = "runningBalance" + ${mmQuantityChange}
          WHERE "paymentType" = 'MOBILE_MONEY'
            AND date > ${invoiceDate}::TIMESTAMP
        `;
      }

      return updatedInvoice;
    });

    res.json(result);
  } catch (error: any) {
    console.error('Invoice update error:', error);
    res.status(500).json({ error: error.message || 'Failed to update invoice' });
  }
});

// Helper to parse dates from various formats (string, serial, Date)
const parseInvoiceDate = (val: any): Date => {
  if (!val) return new Date();
  if (val instanceof Date && !isNaN(val.getTime())) return val;
  if (typeof val === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    return new Date(excelEpoch.getTime() + val * 86400 * 1000);
  }
  const str = String(val).trim();
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) return parsed;
  return new Date();
};

const parsePaymentType = (val: any): PaymentType => {
  const str = String(val || 'CASH').toUpperCase().trim();
  if (str.includes('BANK') || str.includes('ONLINE') || str.includes('WIRE')) return PaymentType.BANK;
  if (str.includes('CREDIT') || str.includes('PENDING')) return PaymentType.CREDIT;
  if (str.includes('MOBILE') || str.includes('AIRTEL') || str.includes('MTN') || str.includes('MOMO')) return PaymentType.MOBILE_MONEY;
  return PaymentType.CASH;
};

const parseNumber = (val: any): number => {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val) return 0;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
};

async function processBulkInvoiceRows(rawRows: any[], defaultType: InvoiceType = 'PURCHASE') {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return { successCount: 0, createdCount: 0, errors: ['No items provided for import'] };
  }

  const errors: string[] = [];
  const groups = new Map<string, {
    invoiceNumber?: string;
    type: InvoiceType;
    date: Date;
    dueDate?: Date | null;
    partyName: string;
    paymentType: PaymentType;
    cashAmount?: number;
    bankAmount?: number;
    notes?: string;
    items: Array<{
      sku?: string;
      itemName: string;
      categoryName?: string;
      unitName?: string;
      quantity: number;
      unitPrice: number;
      costPrice?: number;
      rowNumber: number;
    }>;
  }>();

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rowNum = i + 1;

    const rowTypeStr = (row.type || defaultType).toString().toUpperCase().trim();
    const type: InvoiceType = rowTypeStr === 'SALES' ? 'SALES' : 'PURCHASE';

    const invoiceNumber = (row.invoiceNumber || row.invoiceNo || row.billNo || row['Invoice Number'] || row['Bill No'] || '').toString().trim();
    const partyName = (
      row.partyName || row.supplier || row.supplierName || row.customer || row.customerName || 
      row.vendor || row.client || row['Supplier'] || row['Customer'] || row['Party Name'] || 
      row['Supplier Name'] || row['Customer Name'] || ''
    ).toString().trim();
    const sku = (
      row.sku || row.itemCode || row.item_code || row.code || row['Item Code'] || 
      row['Item SKU'] || row['Item Code (SKU)'] || row['SKU'] || ''
    ).toString().trim();
    const itemName = (
      row.itemName || row.item_name || row.item || row.name || row.productName || 
      row['Item Name'] || row['Product'] || row['Product Name'] || ''
    ).toString().trim();
    const categoryName = (
      row.category || row.categoryName || row.itemGroup || row.item_group || 
      row['Item Group'] || row['Category'] || row['Category (Item Group)'] || 'General'
    ).toString().trim();
    const unitName = (
      row.unit || row.uom || row.unitName || row['Unit of Measure'] || 
      row['UOM'] || row['Unit'] || 'Pcs'
    ).toString().trim();
    const quantity = parseNumber(row.quantity ?? row.qty ?? row['Quantity'] ?? row['Qty']);
    const unitPrice = parseNumber(
      row.unitPrice ?? row.rate ?? row.price ?? row.costPrice ?? 
      row['Unit Price'] ?? row['Rate'] ?? row['Selling Rate / Unit Price'] ?? row['Purchase Rate / Unit Price']
    );
    const costPrice = row.costPrice !== undefined ? parseNumber(row.costPrice) : undefined;
    const date = parseInvoiceDate(row.date || row.invoiceDate || row.billDate || row['Date'] || row['Invoice Date']);
    const dueDateRaw = row.dueDate || row.due_date || row['Due Date'];
    const dueDate = dueDateRaw ? parseInvoiceDate(dueDateRaw) : null;
    const paymentType = parsePaymentType(row.paymentType || row.mode || row.paymentMode || row['Payment Mode'] || row['Payment Type']);
    const cashAmount = row.cashAmount !== undefined ? parseNumber(row.cashAmount) : undefined;
    const bankAmount = row.bankAmount !== undefined ? parseNumber(row.bankAmount) : undefined;
    const notes = (row.notes || row.remarks || row.comment || row['Notes'] || row['Remarks'] || '').toString().trim();

    if (!partyName) {
      errors.push(`Row ${rowNum}: Party Name (${type === 'PURCHASE' ? 'Supplier' : 'Customer'}) is required.`);
      continue;
    }
    if (!itemName && !sku) {
      errors.push(`Row ${rowNum}: Item Name or SKU is required.`);
      continue;
    }
    if (quantity <= 0) {
      errors.push(`Row ${rowNum}: Quantity must be greater than 0.`);
      continue;
    }

    let groupKey: string;
    if (invoiceNumber) {
      groupKey = `NUM_${type}_${invoiceNumber.toUpperCase()}`;
    } else {
      const dStr = date.toISOString().split('T')[0];
      groupKey = `AUTO_${type}_${partyName.toUpperCase()}_${dStr}_${paymentType}`;
    }

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        invoiceNumber: invoiceNumber || undefined,
        type,
        date,
        dueDate,
        partyName,
        paymentType,
        cashAmount,
        bankAmount,
        notes: notes || undefined,
        items: []
      });
    }

    const group = groups.get(groupKey)!;
    group.items.push({
      sku: sku || undefined,
      itemName: itemName || sku,
      categoryName: categoryName || 'General',
      unitName: unitName || 'Pcs',
      quantity,
      unitPrice,
      costPrice,
      rowNumber: rowNum
    });
  }

  let createdInvoicesCount = 0;
  let successCount = 0;

  for (const [, group] of groups) {
    try {
      let invNumber = group.invoiceNumber;
      if (invNumber) {
        const existing = await prisma.invoice.findUnique({ where: { invoiceNumber: invNumber } });
        if (existing) {
          errors.push(`Invoice "${invNumber}" already exists in the system. Skipped.`);
          continue;
        }
      } else {
        invNumber = await generateInvoiceNumber(group.type);
      }

      // 1. Resolve Supplier / Customer Master Data
      let customerId: string | null = null;
      let supplierId: string | null = null;

      if (group.type === 'PURCHASE') {
        let supplier = await prisma.supplier.findFirst({
          where: { name: { equals: group.partyName, mode: 'insensitive' } }
        });
        if (!supplier) {
          supplier = await prisma.supplier.create({
            data: { name: group.partyName, status: 'Active' }
          });
        }
        supplierId = supplier.id;
      } else {
        let customer = await prisma.customer.findFirst({
          where: { name: { equals: group.partyName, mode: 'insensitive' } }
        });
        if (!customer) {
          customer = await prisma.customer.create({
            data: { name: group.partyName, status: 'Active' }
          });
        }
        customerId = customer.id;
      }

      // 2. Resolve Master Data: Category, Unit, SkuMaster & Product (Item Master)
      const resolvedItems: Array<{
        productId: string;
        productName: string;
        quantity: number;
        unitPrice: number;
        costPrice?: number;
      }> = [];

      for (const item of group.items) {
        // A. Resolve or Create Category Master
        let categoryId: string | null = null;
        const catName = (item.categoryName || 'General').trim();
        if (catName) {
          let category = await prisma.category.findFirst({
            where: { name: { equals: catName, mode: 'insensitive' } }
          });
          if (!category) {
            category = await prisma.category.create({
              data: { name: catName, status: 'Active' }
            });
          }
          categoryId = category.id;
        }

        // B. Resolve or Create Unit Master
        let unitId: string | null = null;
        const uName = (item.unitName || 'Pcs').trim();
        if (uName) {
          let unit = await prisma.unit.findFirst({
            where: { name: { equals: uName, mode: 'insensitive' } }
          });
          if (!unit) {
            unit = await prisma.unit.create({
              data: { name: uName, status: 'Active' }
            });
          }
          unitId = unit.id;
        }

        // C. Resolve or Create Item in SkuMaster & Product Master
        const cleanSku = (item.sku || '').trim();
        const cleanName = (item.itemName || cleanSku || 'Unnamed Product').trim();
        const finalSku = cleanSku || (cleanName.toUpperCase().replace(/[^A-Z0-9]/g, '-').slice(0, 12) + '-' + Math.floor(100 + Math.random() * 900));

        let product = cleanSku 
          ? await prisma.product.findUnique({ where: { sku: cleanSku } }) 
          : null;

        if (!product) {
          product = await prisma.product.findFirst({
            where: { name: { equals: cleanName, mode: 'insensitive' } }
          });
        }

        // If Item / SKU ID not found, FIRST ADD TO MASTER:
        if (!product) {
          // 1. Ensure SkuMaster entry exists
          const existingSkuMaster = await prisma.skuMaster.findUnique({ where: { sku: finalSku } });
          if (!existingSkuMaster) {
            await prisma.skuMaster.create({
              data: {
                name: cleanName,
                sku: finalSku,
                categoryId: categoryId,
                status: 'Active',
              }
            });
          }

          // 2. Add Item to Product Master table
          product = await prisma.product.create({
            data: {
              name: cleanName,
              sku: finalSku,
              quantity: 0, // starts at 0, will be updated by Stock Ledger entry
              cost_price: group.type === 'PURCHASE' ? item.unitPrice : 0,
              selling_price: group.type === 'SALES' ? item.unitPrice : (item.unitPrice * 1.25),
              categoryId: categoryId,
              unitId: unitId,
              supplierId: supplierId,
              status: 'Active',
            }
          });
        } else {
          // If product exists in Product Master, ensure SkuMaster also has it
          const existingSkuMaster = await prisma.skuMaster.findUnique({ where: { sku: product.sku } });
          if (!existingSkuMaster) {
            await prisma.skuMaster.create({
              data: {
                name: product.name,
                sku: product.sku,
                categoryId: product.categoryId || categoryId,
                status: 'Active',
              }
            });
          }
          // If category or unit were missing on existing product, update them
          if ((!product.categoryId && categoryId) || (!product.unitId && unitId)) {
            await prisma.product.update({
              where: { id: product.id },
              data: {
                ...((!product.categoryId && categoryId) ? { categoryId } : {}),
                ...((!product.unitId && unitId) ? { unitId } : {}),
              }
            });
          }
        }

        resolvedItems.push({
          productId: product.id,
          productName: product.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          costPrice: item.costPrice
        });
      }

      const totalAmount = resolvedItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
      const invoiceDate = group.date;

      let finalCashAmount = 0;
      let finalBankAmount = 0;
      let finalCreditAmount = 0;
      let finalMobileMoneyAmount = 0;

      if (group.paymentType === PaymentType.CASH) {
        finalCashAmount = group.cashAmount !== undefined ? group.cashAmount : totalAmount;
      } else if (group.paymentType === PaymentType.BANK) {
        finalBankAmount = group.bankAmount !== undefined ? group.bankAmount : totalAmount;
      } else if (group.paymentType === PaymentType.CREDIT) {
        finalCreditAmount = totalAmount;
      } else if (group.paymentType === PaymentType.MOBILE_MONEY) {
        finalMobileMoneyAmount = totalAmount;
      } else {
        finalCashAmount = totalAmount;
      }

      // 3. Database Transaction (Invoice + Stock Ledger + Cashflow)
      await prisma.$transaction(async (tx) => {
        // A. Create Invoice & InvoiceItems
        const invoice = await tx.invoice.create({
          data: {
            invoiceNumber: invNumber!,
            type: group.type,
            date: invoiceDate,
            dueDate: group.dueDate || null,
            notes: group.notes || 'Bulk Imported Invoice',
            totalAmount,
            customerId,
            supplierId,
            paymentType: group.paymentType,
            cashAmount: finalCashAmount,
            bankAmount: finalBankAmount,
            creditAmount: finalCreditAmount,
            mobileMoneyAmount: finalMobileMoneyAmount,
            items: {
              create: resolvedItems.map(item => ({
                productId: item.productId,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                totalPrice: item.quantity * item.unitPrice,
                costPrice: group.type === 'PURCHASE' ? item.unitPrice : (item.costPrice || null),
              }))
            }
          }
        });

        // B. Add Ledger Entry: Add or Reduce Stock for each SKU
        for (const item of resolvedItems) {
          const product = await tx.product.findUnique({ where: { id: item.productId } });
          if (!product) continue;

          // PURCHASE adds stock (+), SALES reduces stock (-)
          const quantityChange = group.type === 'PURCHASE' ? Number(item.quantity) : -Number(item.quantity);

          const currentBalanceResult: any = await tx.$queryRaw`
            SELECT COALESCE(SUM("quantityChange"), 0) AS balance_before
            FROM "StockLedger"
            WHERE "productId" = ${item.productId}
              AND date < ${invoiceDate}::TIMESTAMP
          `;
          const balanceBefore = currentBalanceResult[0]?.balance_before ? Number(currentBalanceResult[0].balance_before) : 0;
          const newRunningBalance = balanceBefore + quantityChange;

          // Insert into Stock Ledger
          await tx.stockLedger.create({
            data: {
              productId: item.productId,
              date: invoiceDate,
              type: group.type,
              quantityChange,
              runningBalance: newRunningBalance,
              invoiceId: invoice.id,
            }
          });

          // Forward recalculate running balance if backdated
          await tx.$queryRaw`
            UPDATE "StockLedger"
            SET "runningBalance" = "runningBalance" + ${quantityChange}
            WHERE "productId" = ${item.productId}
              AND date > ${invoiceDate}::TIMESTAMP
          `;

          // Update Product quantity in Master
          await tx.product.update({
            where: { id: item.productId },
            data: {
              quantity: product.quantity + quantityChange,
              ...(group.type === 'PURCHASE' ? { cost_price: item.unitPrice } : {})
            }
          });
        }

        // C. Add Entry in Cash Flow (Cash Ledger & Payments)
        if (finalCashAmount > 0) {
          const cashQuantityChange = group.type === 'SALES' ? finalCashAmount : -finalCashAmount;

          const currentCashBalanceResult: any = await tx.$queryRaw`
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
              sourceType: group.type === 'SALES' ? 'SALE' : 'PURCHASE',
              amountChange: cashQuantityChange,
              runningBalance: newCashRunningBalance,
              invoiceId: invoice.id,
            }
          });

          await tx.$queryRaw`
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${cashQuantityChange}
            WHERE "paymentType" = 'CASH'
              AND date > ${invoiceDate}::TIMESTAMP
          `;

          await tx.payment.create({
            data: {
              date: invoiceDate,
              paymentType: 'CASH',
              direction: group.type === 'SALES' ? 'IN' : 'OUT',
              amount: finalCashAmount,
              description: `Bulk Import ${group.type === 'SALES' ? 'Sale' : 'Purchase'} Invoice ${invoice.invoiceNumber}`,
              customerId,
              supplierId,
              invoiceId: invoice.id,
            }
          });
        }

        if (finalBankAmount > 0) {
          const bankQuantityChange = group.type === 'SALES' ? finalBankAmount : -finalBankAmount;

          const currentBankBalanceResult: any = await tx.$queryRaw`
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
              sourceType: group.type === 'SALES' ? 'SALE' : 'PURCHASE',
              amountChange: bankQuantityChange,
              runningBalance: newBankRunningBalance,
              invoiceId: invoice.id,
            }
          });

          await tx.$queryRaw`
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${bankQuantityChange}
            WHERE "paymentType" = 'BANK'
              AND date > ${invoiceDate}::TIMESTAMP
          `;

          await tx.payment.create({
            data: {
              date: invoiceDate,
              paymentType: 'BANK',
              direction: group.type === 'SALES' ? 'IN' : 'OUT',
              amount: finalBankAmount,
              description: `Bulk Import ${group.type === 'SALES' ? 'Sale' : 'Purchase'} Invoice ${invoice.invoiceNumber}`,
              customerId,
              supplierId,
              invoiceId: invoice.id,
            }
          });
        }

        if (finalMobileMoneyAmount > 0) {
          const mmQuantityChange = group.type === 'SALES' ? finalMobileMoneyAmount : -finalMobileMoneyAmount;

          const currentMMBalanceResult: any = await tx.$queryRaw`
            SELECT COALESCE(SUM("amountChange"), 0) AS balance_before
            FROM "CashLedger"
            WHERE "paymentType" = 'MOBILE_MONEY'
              AND date < ${invoiceDate}::TIMESTAMP
          `;
          const mmBalanceBefore = currentMMBalanceResult[0]?.balance_before ? Number(currentMMBalanceResult[0].balance_before) : 0;
          const newMMRunningBalance = mmBalanceBefore + mmQuantityChange;

          await tx.cashLedger.create({
            data: {
              date: invoiceDate,
              paymentType: 'MOBILE_MONEY',
              sourceType: group.type === 'SALES' ? 'SALE' : 'PURCHASE',
              amountChange: mmQuantityChange,
              runningBalance: newMMRunningBalance,
              invoiceId: invoice.id,
            }
          });

          await tx.$queryRaw`
            UPDATE "CashLedger"
            SET "runningBalance" = "runningBalance" + ${mmQuantityChange}
            WHERE "paymentType" = 'MOBILE_MONEY'
              AND date > ${invoiceDate}::TIMESTAMP
          `;

          await tx.payment.create({
            data: {
              date: invoiceDate,
              paymentType: 'MOBILE_MONEY',
              direction: group.type === 'SALES' ? 'IN' : 'OUT',
              amount: finalMobileMoneyAmount,
              description: `Bulk Import ${group.type === 'SALES' ? 'Sale' : 'Purchase'} Invoice ${invoice.invoiceNumber}`,
              customerId,
              supplierId,
              invoiceId: invoice.id,
            }
          });
        }
      });

      createdInvoicesCount++;
      successCount += group.items.length;
    } catch (err: any) {
      errors.push(`Invoice "${group.invoiceNumber || group.partyName}": ${err.message}`);
    }
  }

  return { successCount, createdCount: createdInvoicesCount, errors };
}

// POST bulk import invoices (JSON array)
router.post('/bulk-import', async (req: Request, res: Response) => {
  try {
    const rawItems = Array.isArray(req.body) ? req.body : (req.body.items || []);
    const defaultType: InvoiceType = (req.body.type === 'SALES' ? 'SALES' : 'PURCHASE');
    const result = await processBulkInvoiceRows(rawItems, defaultType);
    res.json({
      message: `Successfully processed ${result.successCount} item(s) across ${result.createdCount} invoice(s).`,
      ...result
    });
  } catch (error: any) {
    console.error('Bulk import invoices error:', error);
    res.status(500).json({ error: error.message || 'Failed to process bulk import' });
  }
});

// POST bulk upload invoices (Excel/CSV File)
router.post('/bulk-upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const defaultType: InvoiceType = (req.body.type === 'SALES' ? 'SALES' : 'PURCHASE');
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const result = await processBulkInvoiceRows(rawRows, defaultType);
    res.json({
      message: `Successfully processed ${result.successCount} item(s) across ${result.createdCount} invoice(s).`,
      ...result
    });
  } catch (error: any) {
    console.error('Bulk upload invoices error:', error);
    res.status(500).json({ error: error.message || 'Failed to process bulk upload' });
  }
});

// DELETE invoice by id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.stockLedger.deleteMany({ where: { invoiceId: id } });
      await tx.cashLedger.deleteMany({ where: { invoiceId: id } });
      await tx.invoice.delete({ where: { id } });
    });
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete invoice' });
  }
});

export default router;
