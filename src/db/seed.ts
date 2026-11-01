/**
 * Seed catalogue. Prices are integer paise (₹1 = 100 paise).
 * Two products have deliberately small stock so overselling scenarios are easy
 * to exercise by hand and in tests.
 */
export const SEED_PRODUCTS = [
  { id: 'p-tshirt', name: 'Cotton T-Shirt', pricePaise: 49_900, stock: 100 },
  { id: 'p-jeans', name: 'Denim Jeans', pricePaise: 129_999, stock: 50 },
  { id: 'p-hoodie', name: 'Fleece Hoodie', pricePaise: 189_900, stock: 25 },
  { id: 'p-cap', name: 'Baseball Cap', pricePaise: 29_950, stock: 200 },
  { id: 'p-sneakers-ltd', name: 'Limited Edition Sneakers', pricePaise: 799_900, stock: 3 },
  { id: 'p-poster-signed', name: 'Signed Poster', pricePaise: 99_900, stock: 1 },
] as const;
