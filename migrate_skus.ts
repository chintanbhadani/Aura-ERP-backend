import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const skus = await prisma.skuMaster.findMany();
  
  let supplier = await prisma.supplier.findFirst();
  if (!supplier) {
    supplier = await prisma.supplier.create({ data: { name: "Default Supplier" } });
  }

  let defaultCategory = await prisma.category.findFirst({ where: { name: 'Uncategorized' } });
  if (!defaultCategory) {
    defaultCategory = await prisma.category.create({ data: { name: 'Uncategorized' } });
  }

  let count = 0;
  for (const sku of skus) {
    const existingProduct = await prisma.product.findUnique({
      where: { sku: sku.sku }
    });
    
    if (!existingProduct) {
      await prisma.product.create({
        data: {
          name: sku.name,
          sku: sku.sku,
          categoryId: sku.categoryId || defaultCategory.id,
          supplierId: supplier.id,
          cost_price: 0,
          selling_price: 0,
          quantity: 0,
          min_stock: 0,
          status: 'Active',
          location: ''
        }
      });
      count++;
      console.log(`Migrated SKU: ${sku.sku}`);
    }
  }
  console.log(`Successfully migrated ${count} SKUs to Products.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
