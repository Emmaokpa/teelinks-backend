// server.js
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js'); // Supabase client
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// server.js
// ... (other requires)

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;

if (!ADMIN_SECRET) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("FATAL: ADMIN_SECRET_KEY is not defined in the .env file.");
    console.error("Admin routes will not be protected. Please set this variable.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    // process.exit(1); // Optionally exit if secret is crucial for startup
}

const authenticateAdmin = (req, res, next) => {
    if (!ADMIN_SECRET) { // Fallback if .env is missing, though we logged an error
        console.warn("Admin authentication is disabled because ADMIN_SECRET_KEY is not set.");
        return next(); // In a real scenario, you might want to deny access here.
    }

    const providedSecret = req.headers['x-admin-secret-key'];
    if (providedSecret && providedSecret === ADMIN_SECRET) {
        next(); // Secret is correct, proceed to the route handler
    } else {
        console.warn("Unauthorized attempt to access admin route. Missing or incorrect secret key.");
        res.status(401).json({ message: 'Unauthorized: Access is denied.' });
    }
};

// ... (rest of your Express app setup, Supabase client, Multer setup)


// --- Supabase Client Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("FATAL: SUPABASE_URL or SUPABASE_SERVICE_KEY is missing from .env");
    console.error("Please ensure these are set correctly.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);
console.log("Supabase client initialized.");

// --- Multer Setup for File Uploads ---
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)){
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log(`Created 'uploads' directory at: ${uploadsDir}`);
}

const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-')); // Sanitize filename
    }
});

const upload = multer({
    storage: multerStorage,
    fileFilter: (req, file, cb) => {
        // Basic image file type filter
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Not an image! Please upload an image.'), false);
        }
    }
});

// --- Routes ---

// POST route to add a new product
app.post('/api/products', authenticateAdmin, upload.single('productImage'), async (req, res) => {
    try {
        let { name, description, affiliateLink, price, category, isTopPick } = req.body; // Added category and isTopPick
        const imageFile = req.file;

        if (!name || !affiliateLink || !imageFile) {
            if (imageFile && fs.existsSync(imageFile.path)) {
                fs.unlinkSync(imageFile.path);
            }
            return res.status(400).json({ message: 'Name, affiliate link, and product image are required.' });
        }

        let imageFileId = null;
        let imageUrl = null;
        // let imagePathInBucket = null; // We won't store this separately in the DB if only image_url is used
        const bucketName = 'product-images'; // Should match your Supabase bucket name

        try {
            const fileContent = fs.readFileSync(imageFile.path);
            // Define a path within the bucket. Still useful for uploading, even if not stored in DB.
            const imagePathInBucket = `public/${Date.now()}-${imageFile.filename}`; 
            console.log(`Attempting to upload file: ${imageFile.filename} to Supabase bucket: ${bucketName} at path: ${imagePathInBucket}`);

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from(bucketName)
                .upload(imagePathInBucket, fileContent, {
                    contentType: imageFile.mimetype,
                    upsert: false // true to overwrite if file with same path exists
                });

            if (uploadError) {
                throw uploadError;
            }

            console.log("Supabase Storage: File uploaded successfully. Path:", uploadData.path);

            // Get public URL
            const { data: publicUrlData } = supabase.storage
                .from(bucketName)
                .getPublicUrl(imagePathInBucket);

            if (!publicUrlData || !publicUrlData.publicUrl) {
                 throw new Error('Could not get public URL for the uploaded image.');
            }
            imageUrl = publicUrlData.publicUrl;
            console.log("Supabase Storage: Image URL:", imageUrl);

        } catch (storageError) {
            console.error('Supabase Storage Error:', storageError);
            if (imageFile && fs.existsSync(imageFile.path)) {
                fs.unlinkSync(imageFile.path);
            }
            let errorMessage = 'Failed to upload image to Supabase storage.';
            if (storageError && storageError.message) {
                errorMessage += ` Details: ${storageError.message}`;
            }
            return res.status(500).json({ message: errorMessage, error: storageError.message || storageError });
        } finally {
            // Always clean up the local temporary file
            if (imageFile && fs.existsSync(imageFile.path)) {
                fs.unlinkSync(imageFile.path);
                console.log(`Cleaned up local file: ${imageFile.path}`);
            }
        }

        const productData = {
            name,
            description: description || null, // Use null for empty optional fields in SQL
            affiliate_link: affiliateLink,
            price: price || null,
            image_url: imageUrl,
            // image_path: imagePathInBucket // We decided not to store this
            category: category || null, // Save category, default to null if empty
            is_top_pick: isTopPick === 'true' // Convert string "true" to boolean true, otherwise false
        };

        console.log("Attempting to insert document into Supabase 'products' table:", productData);
        console.log(`Value of isTopPick from req.body: '${isTopPick}' (type: ${typeof isTopPick})`);
        console.log(`Calculated boolean for is_top_pick: ${isTopPick === 'true'}`);

        const { data: dbData, error: dbError } = await supabase
            .from('products')
            .insert([productData])
            .select()
            .single(); // .select().single() returns the inserted row as an object

        if (dbError) {
            throw dbError;
        }
        console.log("Supabase Database: Document inserted successfully:", dbData);
        res.status(201).json({ message: 'Product added successfully!', data: dbData });

    } catch (error) {
        console.error('Error adding product:', error);
        // Ensure local file is cleaned up if any operation fails
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        let errorMessage = 'Failed to add product.';
        if (error && error.message) {
            errorMessage += ` Details: ${error.message}`;
        }
        res.status(500).json({ message: errorMessage, error: error.message || error });
    }
});

// GET route to fetch only top pick products
app.get('/api/products/toppicks', async (req, res) => {
    try {
        console.log("Fetching top pick products from Supabase 'products' table...");
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('is_top_pick', true) // Filter for top picks
            .order('created_at', { ascending: false }) // Optional: order
            .limit(8); // Optional: limit the number of top picks displayed

        if (error) {
            throw error;
        }
        console.log(`Found ${data.length} top pick products.`);
        res.status(200).json(data);
    } catch (error) {
        console.error('Error fetching top pick products from Supabase:', error);
        res.status(500).json({ message: 'Failed to fetch top pick products.', error: error.message });
    }
});


// GET route to fetch all products
app.get('/api/products', async (req, res) => {
    try {
        const { category, search, page = 1, limit = 12 } = req.query; // Add page, limit, and search
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const offset = (pageNum - 1) * limitNum;

        let query = supabase
            .from('products')
            .select('*', { count: 'exact' }) // Request total count for pagination
            .order('created_at', { ascending: false }); // Optional: order by creation date

        if (category) {
            console.log(`Filtering by category: ${category}`);
            query = query.eq('category', category); // Add filter for category
        }

        if (search) {
            console.log(`Searching for: ${search}`);
            query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
        }

        // Apply pagination
        query = query.range(offset, offset + limitNum - 1);

        console.log(`Executing Supabase query to fetch products (page: ${pageNum}, limit: ${limitNum}, offset: ${offset})...`);
        const { data, error, count } = await query; // Destructure count

        if (error) {
            throw error;
        }
        console.log(`Found ${data.length} products for this page. Total matching items: ${count}`);
        res.status(200).json({
            products: data,
            totalProducts: count,
            currentPage: pageNum,
            totalPages: Math.ceil(count / limitNum)
        });
    } catch (error) {
        console.error('Error fetching products from Supabase:', error);
        res.status(500).json({ message: 'Failed to fetch products.', error: error.message });
    }
});


// PUT route to update an existing product
app.put('/api/products/:id', authenticateAdmin, upload.single('productImage'), async (req, res) => {
    const { id } = req.params;
    let { name, description, affiliateLink, price, category, isTopPick } = req.body;
    const imageFile = req.file;

    console.log(`Attempting to update product ID: ${id}`);
    console.log("Received update data:", req.body);
    if (imageFile) {
        console.log("New image file provided:", imageFile.originalname);
    }

    try {
        const updateData = {
            // name, // Only include if name is provided and not empty
            // description: description || null,
            // affiliate_link: affiliateLink,
            // price: price || null,
            // category: category || null,
            // is_top_pick: isTopPick === 'true',
        };

        // Conditionally add fields to updateData to avoid overwriting with undefined or empty strings
        // if they are not meant to be cleared.
        if (name !== undefined) updateData.name = name;
        if (description !== undefined) updateData.description = description || null;
        if (affiliateLink !== undefined) updateData.affiliate_link = affiliateLink;
        if (price !== undefined) updateData.price = price || null;
        if (category !== undefined) updateData.category = category || null;
        if (isTopPick !== undefined) updateData.is_top_pick = isTopPick === 'true';


        // If a new image is uploaded, handle it
        if (imageFile) {
            const bucketName = 'product-images';
            const fileContent = fs.readFileSync(imageFile.path);
            const imagePathInBucket = `public/${Date.now()}-${imageFile.filename.replace(/\s+/g, '-')}`;

            console.log(`Uploading new image to Supabase bucket: ${bucketName} at path: ${imagePathInBucket}`);
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from(bucketName)
                .upload(imagePathInBucket, fileContent, {
                    contentType: imageFile.mimetype,
                    upsert: true // Use upsert true if you want to overwrite
                });

            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from(bucketName)
                .getPublicUrl(imagePathInBucket);
            
            if (!publicUrlData || !publicUrlData.publicUrl) {
                throw new Error('Could not get public URL for the new uploaded image.');
            }
            updateData.image_url = publicUrlData.publicUrl;
            
            if (fs.existsSync(imageFile.path)) {
                fs.unlinkSync(imageFile.path);
                console.log(`Cleaned up local temp file for update: ${imageFile.path}`);
            }
        } else {
            console.log("No new image provided for update.");
        }
        
        // Ensure there's something to update if no image and other fields might be empty
        if (Object.keys(updateData).length === 0) {
            // If only an image was potentially changed but not provided,
            // and no other fields are being updated, we might not need to hit the DB.
            // However, the current logic will proceed if any field (even if empty string converting to null) is present.
            // For a more robust update, you might check if updateData is truly empty.
            console.log("No actual data fields to update (excluding potential image change if no new image was uploaded).");
        }


        console.log("Updating product in Supabase with data:", updateData);
        const { data: dbData, error: dbError } = await supabase
            .from('products')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (dbError) throw dbError;

        if (!dbData) {
            // This can happen if the ID doesn't exist or if the updateData resulted in no actual change
            // to the row according to Supabase (e.g., all values were the same).
            // However, .select().single() should return the row if it exists, even if no fields changed.
            // A 404 might be more appropriate if the ID truly doesn't exist.
            console.warn(`Product with ID ${id} not found or no changes were made during update.`);
            // Let's assume if dbData is null after an update attempt on an existing ID, the ID was wrong.
            // If the ID is correct but no fields changed, Supabase update might return the existing row.
            // If the ID is invalid, Supabase might return an error or null data.
            // For now, if dbData is null, let's treat it as not found.
            return res.status(404).json({ message: 'Product not found.' });
        }

        console.log("Supabase Database: Product updated successfully:", dbData);
        res.status(200).json({ message: 'Product updated successfully!', data: dbData });

    } catch (error) {
        console.error(`Error updating product ${id}:`, error);
        if (imageFile && fs.existsSync(imageFile.path)) { 
            fs.unlinkSync(imageFile.path);
        }
        res.status(500).json({ message: `Failed to update product. Details: ${error.message}`, error: error.message || error });
    }
});

// DELETE route to remove a product
app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    console.log(`Attempting to delete product ID: ${id}`);

    try {
        // Optional: First, fetch the product to get its image_url for deletion from storage
        const { data: productToDelete, error: fetchError } = await supabase
            .from('products')
            .select('image_url')
            .eq('id', id)
            .single();

        if (fetchError || !productToDelete) {
            console.warn(`Product with ID ${id} not found for deletion or error fetching it.`, fetchError);
            // If product not found, we might still proceed to attempt deletion from DB,
            // or return 404 if fetchError indicates it doesn't exist.
            // For now, let's proceed to delete from DB, Supabase handles non-existent deletes gracefully.
        }

        // Delete the product from the database
        const { error: dbDeleteError } = await supabase
            .from('products')
            .delete()
            .eq('id', id);

        if (dbDeleteError) {
            throw dbDeleteError;
        }

        console.log(`Product with ID ${id} deleted from database.`);

        // If product had an image_url, attempt to delete it from storage
        if (productToDelete && productToDelete.image_url) {
            const bucketName = 'product-images';
            // Extract the path from the public URL.
            // Example URL: https://<project-ref>.supabase.co/storage/v1/object/public/product-images/public/image.jpg
            // The path within the bucket would be 'public/image.jpg'
            const urlParts = productToDelete.image_url.split(`/storage/v1/object/public/${bucketName}/`);
            if (urlParts.length > 1) {
                const imagePathInBucket = urlParts[1];
                console.log(`Attempting to delete image from storage: ${bucketName}/${imagePathInBucket}`);
                const { error: storageDeleteError } = await supabase.storage
                    .from(bucketName)
                    .remove([imagePathInBucket]);
                if (storageDeleteError) {
                    console.warn(`Failed to delete image from storage (product DB record deleted successfully): ${storageDeleteError.message}`);
                    // Don't fail the whole request if image deletion fails, but log it.
                } else {
                    console.log(`Image ${imagePathInBucket} deleted from storage.`);
                }
            }
        }

        res.status(200).json({ message: `Product with ID ${id} deleted successfully.` });

    } catch (error) {
        console.error(`Error deleting product ${id}:`, error);
        res.status(500).json({ message: `Failed to delete product. Details: ${error.message}`, error: error.message || error });
    }
});

app.listen(port, () => {
    console.log(`Teelinks backend server running on http://localhost:${port}`);
});
