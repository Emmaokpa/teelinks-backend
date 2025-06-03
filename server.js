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
// Configure CORS to allow requests only from your frontend domain
const allowedOrigins = ['https://teelinks.infy.uk']; // Replace with your actual frontend URL
// Add localhost for local development testing
if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push('http://localhost:5500'); // Adjust port if your local frontend uses a different one
    allowedOrigins.push('http://127.0.0.1:5500'); // Sometimes 127.0.0.1 is needed too
}
app.use(cors({
    origin: allowedOrigins
}));

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
    if (!ADMIN_SECRET) {
        console.error("Admin authentication failed: ADMIN_SECRET_KEY is not set on the server. Access will be allowed without authentication (dev fallback).");
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




// --- Supabase Client Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use SERVICE_ROLE_KEY for backend operations

if (!supabaseUrl || !supabaseKey) {
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("FATAL: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from .env or environment variables.");
    console.error("Please ensure these are set correctly.");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    process.exit(1); // Exit if essential config is missing
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log("Supabase client initialized.");

// --- Multer Setup for File Uploads ---
// Use memoryStorage to avoid writing to the ephemeral filesystem on Render
const multerStorage = multer.memoryStorage();

const upload = multer({
    storage: multerStorage,
    fileFilter: (req, file, cb) => {
        // Basic image file type filter
        // Also check file size if needed
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
            return res.status(400).json({ message: 'Name, affiliate link, and product image are required.' });
        }

        let imageUrl = null;
        let imagePathInBucket = null; // Store this to use for deletion later
        const bucketName = 'product-images'; // Should match your Supabase bucket name

        // Use file.buffer with memoryStorage
        try {
            // Define a path within the bucket. Still useful for uploading, even if not stored in DB.
            const generatedPath = `public/${Date.now()}-${imageFile.originalname.replace(/\s+/g, '-')}`; 
            console.log(`Attempting to upload file: ${imageFile.originalname} to Supabase bucket: ${bucketName} at path: ${generatedPath}`);

            const { data: uploadData, error: uploadError } = await supabase.storage
                .from(bucketName)
                .upload(generatedPath, imageFile.buffer, { // Use file.buffer here
                    contentType: imageFile.mimetype,
                    upsert: false // true to overwrite if file with same path exists
                });

            if (uploadError) {
                throw uploadError;
            }

            console.log("Supabase Storage: File uploaded successfully. Path:", uploadData.path);

            // Get public URL
            // Note: Supabase recommends using the path from uploadData.path for getPublicUrl
            const { data: publicUrlData } = supabase.storage
                .from(bucketName)
                .getPublicUrl(uploadData.path); // Use path from uploadData

            if (!publicUrlData || !publicUrlData.publicUrl) {
                 throw new Error('Could not get public URL for the uploaded image.');
            }
            imageUrl = publicUrlData.publicUrl;
            imagePathInBucket = uploadData.path; // Store the path returned by Supabase
            console.log("Supabase Storage: Image URL:", imageUrl);

        } catch (storageError) {
            console.error('Supabase Storage Error:', storageError);
            let errorMessage = 'Failed to upload image to Supabase storage.';
            if (storageError && storageError.message) {
                errorMessage += ` Details: ${storageError.message}`;
            }
            return res.status(500).json({ message: errorMessage, error: storageError.message || storageError });
        }

        const productData = {
            name,
            description: description || null, // Use null for empty optional fields in SQL
            affiliate_link: affiliateLink,
            price: price || null,
            image_url: imageUrl,
            image_path_in_bucket: imagePathInBucket, // Store the path for easier deletion
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
            const generatedPath = `public/${Date.now()}-${imageFile.originalname.replace(/\s+/g, '-')}`;

            console.log(`Uploading new image to Supabase bucket: ${bucketName} at path: ${generatedPath}`);
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from(bucketName)
                .upload(generatedPath, imageFile.buffer, { // Use file.buffer
                    contentType: imageFile.mimetype,
                    upsert: true // Use upsert true if you want to overwrite
                });

            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from(bucketName)
                .getPublicUrl(uploadData.path); // Use path from uploadData
            
            if (!publicUrlData || !publicUrlData.publicUrl) {
                throw new Error('Could not get public URL for the new uploaded image.');
            }
            updateData.image_url = publicUrlData.publicUrl;
            updateData.image_path_in_bucket = uploadData.path; // Store the new path

            // TODO: Consider deleting the old image from storage if a new one is uploaded
            // You would need to fetch the old image_path_in_bucket before the update
        } else {
            console.log("No new image provided for update.");
        }
        
        // Ensure there's something to update if no image and other fields might be empty
        if (Object.keys(updateData).length === 0) {
            // If no fields were provided in the body and no new image was uploaded,
            // there's nothing to update in the database.
            console.log("No update data provided.");
            return res.status(400).json({ message: "No update data provided." });
        }

        // Conditionally add fields to updateData if they are provided in the request body
        // This prevents overwriting existing data with undefined or null if the field wasn't sent.
        if (req.body.name !== undefined) updateData.name = req.body.name;
        if (req.body.description !== undefined) updateData.description = req.body.description || null;
        if (req.body.affiliateLink !== undefined) updateData.affiliate_link = req.body.affiliateLink;
        if (req.body.price !== undefined) updateData.price = req.body.price || null;
        if (req.body.category !== undefined) updateData.category = req.body.category || null;
        if (req.body.isTopPick !== undefined) updateData.is_top_pick = req.body.isTopPick === 'true';

        // Ensure there's something to update if no image and other fields might be empty
        if (Object.keys(updateData).length === 0) {
            console.log("No update data provided.");
            return res.status(400).json({ message: "No update data provided." });
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
            // If Supabase update with .eq('id', id) and .single() returns null data,
            // it typically means no row matched the ID.
            console.warn(`Product with ID ${id} not found for update.`);
            return res.status(404).json({ message: 'Product not found.' });
        }

        console.log("Supabase Database: Product updated successfully:", dbData);
        res.status(200).json({ message: 'Product updated successfully!', data: dbData });
    } catch (error) {
        console.error(`Error updating product ${id}:`, error);
        // With memoryStorage, local file cleanup for imageFile is not needed here.
        res.status(500).json({ message: `Failed to update product. Details: ${error.message}`, error: error.message || error });
    }
});

// DELETE route to remove a product
app.delete('/api/products/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    console.log(`Attempting to delete product ID: ${id}`);

    try {
        // Fetch the product first to get its image_path_in_bucket for deletion from storage
        const { data: productToDelete, error: fetchError } = await supabase
            .from('products')
            .select('image_path_in_bucket') // Select the stored path
            .eq('id', id)
            .single();

        if (fetchError || !productToDelete) {
            console.warn(`Product with ID ${id} not found for deletion or error fetching it.`, fetchError);
             // If product not found, we can return 404 immediately
             if (fetchError && fetchError.code === 'PGRST116') { // Supabase code for not found
                 return res.status(404).json({ message: 'Product not found.' });
             }
            // Otherwise, log the error and proceed to attempt DB deletion just in case
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

        // If product had an image_path_in_bucket, attempt to delete it from storage
        if (productToDelete && productToDelete.image_path_in_bucket) {
            const bucketName = 'product-images';
            const imagePathInBucket = productToDelete.image_path_in_bucket; // Use the stored path directly

            console.log(`Attempting to delete image from storage: ${bucketName}/${imagePathInBucket}`);
            const { error: storageDeleteError } = await supabase.storage
                .from(bucketName)
                .remove([imagePathInBucket]); // Pass the path in an array

            if (storageDeleteError) {
                console.warn(`Failed to delete image from storage (product DB record deleted successfully): ${storageDeleteError.message}`);
                // Don't fail the whole request if image deletion fails, but log it.
            } else {
                console.log(`Image ${imagePathInBucket} deleted from storage.`);
            }
        }

        res.status(200).json({ message: `Product with ID ${id} deleted successfully.` });

    } catch (error) {
        console.error(`Error deleting product ${id}:`, error);
        res.status(500).json({ message: `Failed to delete product. Details: ${error.message}`, error: error.message || error });
    }
});

app.listen(port, '0.0.0.0', () => { // Listen on 0.0.0.0 for Render
    console.log(`Teelinks backend server running on host 0.0.0.0 port ${port}`);
});
