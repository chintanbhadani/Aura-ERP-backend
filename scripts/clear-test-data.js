const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  const args = process.argv.slice(2);
  const isForce = args.includes('--force') || args.includes('-f');
  const wipeEverything = args.includes('--wipe-all') || args.includes('--wipe-everything');
  const wipeAllExceptUsers = args.includes('--all') && !wipeEverything;

  console.log('====================================================');
  console.log('   ⚠️  ERP SERVER TEST DATA CLEANUP UTILITY  ⚠️    ');
  console.log('====================================================');

  if (wipeEverything) {
    console.log('Mode: ⚠️ WIPE ALL TABLES COMPLETELY (All tables will be emptied)');
  } else if (wipeAllExceptUsers) {
    console.log('Mode: WIPE ALL DATA EXCEPT USERS (Keeps User accounts & Roles)');
  } else {
    console.log('Mode: TRANSACTIONS ONLY (Clears invoices, ledgers, payments, expenses, resets product stock)');
  }

  if (!isForce) {
    const answer = await askQuestion('\nAre you sure you want to proceed? Type "yes" to confirm: ');
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('❌ Operation cancelled.');
      process.exit(0);
    }
  }

  console.log('\n🚀 Clearing data...');

  try {
    if (wipeEverything) {
      // Truncate all tables in public schema
      await prisma.$executeRawUnsafe(`
        DO $$ DECLARE
            r RECORD;
        BEGIN
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%') LOOP
                EXECUTE 'TRUNCATE TABLE "' || r.tablename || '" CASCADE;';
            END LOOP;
        END $$;
      `);
      console.log('✅ All application tables have been completely cleared!');

      // Ask to re-seed default admin or auto-seed
      console.log('\n🌱 Creating default admin account...');
      await prisma.user.upsert({
        where: { username: 'admin@aura.com' },
        update: {},
        create: {
          username: 'admin@aura.com',
          password: 'password123',
          role: 'PLANT_ADMIN',
          status: 'Active',
          name: 'Super Admin'
        },
      });
      console.log('✅ Default Admin account created:');
      console.log('   Username: admin@aura.com');
      console.log('   Password: password123');

    } else if (wipeAllExceptUsers) {
      // Clear transactional + masters except Users
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE 
          "InvoiceItem",
          "StockLedger",
          "CashLedger",
          "Payment",
          "Invoice",
          "Expense",
          "ExpenseMaster",
          "RepackEntry",
          "StockCountItem",
          "StockCountSession",
          "Product",
          "SkuMaster",
          "SubPartOf",
          "PartOf",
          "Customer",
          "Supplier",
          "Category",
          "Unit",
          "CashBookConfig"
        CASCADE;
      `);
      console.log('✅ Cleared: Invoices, Ledgers, Payments, Expenses, Repacks, Stock Counts, Products, Customers, Suppliers, Categories, Units, SKUs.');
      console.log('ℹ️  Kept: Users & Roles');
    } else {
      // Clear only transactional data
      await prisma.$executeRawUnsafe(`
        TRUNCATE TABLE 
          "InvoiceItem",
          "StockLedger",
          "CashLedger",
          "Payment",
          "Invoice",
          "Expense",
          "RepackEntry",
          "StockCountItem",
          "StockCountSession"
        CASCADE;
      `);
      console.log('✅ Cleared: Invoices, InvoiceItems, StockLedgers, CashLedgers, Payments, Expenses, RepackEntries, StockCountSessions.');

      // Reset product stock counts to 0
      const updateResult = await prisma.product.updateMany({
        data: {
          quantity: 0
        }
      });
      console.log(`✅ Reset inventory quantity to 0 for ${updateResult.count} products.`);
    }

    console.log('\n🎉 Cleanup completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Error while clearing data:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    rl.close();
  }
}

main();
