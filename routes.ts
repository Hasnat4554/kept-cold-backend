import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { supabase, supabaseAuth } from "./supabase.js";
import { engineerRegistrationSchema } from "./lib/schema.js";
import fetch from "node-fetch"; // ✅ ensure available in package.json
import axios from "axios";
import { Buffer } from "buffer";
import ImageKit from "imagekit";
import multer from "multer";

// Initialize ImageKit
console.log('Supabase URL:', process.env.IMAGEKIT_URL_ENDPOINT);
console.log('Supabase URL:', process.env.IMAGEKIT_PUBLIC_KEEY);
console.log('Supabase URL:', process.env.IMAGEKIT_PRIVATE_KEY);
const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEEY || "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "",
});

// Configure multer for memory storage (files stored as buffers)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB limit per file
});

// Extend Express Request type to include adminUser
interface AdminRequest extends Request {
  adminUser?: {
    user_id: string;
    role: string;
    email: string;
  };
}

/* ===========================
   ADMIN AUTHENTICATION MIDDLEWARE
============================*/
async function requireAdminAuth(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Extract Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        error: "Unauthorized",
        message: "No authentication token provided",
      });
      return;
    }



    // Extract token
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token with dedicated auth client (doesn't affect main client's RLS context)
    const {
      data: { user },
      error: authError,
    } = await supabaseAuth.auth.getUser(token);

    if (authError || !user) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or expired authentication token",
      });
      return;
    }

    // Verify admin role in user_roles table (using main service-role client)
    const { data: roleData, error: roleError } = await supabase
      .from("user_roles")
      .select("*")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .single();
  
    if (roleError || !roleData) {
      res.status(403).json({
        error: "Forbidden",
        message: "Admin privileges required. Access denied.",
      });
      return;
    }

    // Attach user info to request object
    req.adminUser = {
      user_id: user.id,
      role: roleData.role,
      email: user.email || "",
    };

    next();
  } catch (err) {
    console.error("Admin auth middleware error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: "Authentication verification failed",
    });
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  /* ===========================
     ENGINEER REGISTRATION
  ============================*/

  app.post("/api/engineers/signup", async (req, res) => {
  try {
    // 1️⃣ Validate request body
    const validation = engineerRegistrationSchema.safeParse(req.body);
    if (!validation.success) {
      const errors = validation.error.flatten().fieldErrors;
      return res.status(400).json({ error: errors });
    }

    const {
      email,
      password,
      eng_name,
      speciality,
      area,
      working_status,
      work_start_time,
      work_end_time,
    } = validation.data;

    const formatTimeWithTimezone = (time: string) => `${time}:00+05:00`;

    // 2️⃣ Create Auth user using service role client (bypasses RLS)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // optional: auto confirm
    });

    if (authError || !authData.user) {
      return res
        .status(400)
        .json({ error: authError?.message || "Failed to create account" });
    }

    // 3️⃣ Insert engineer record using service role client
    const { data: engineerData, error: engineerError } = await supabase
      .from("engineers")
      .insert({
        id: authData.user.id,
        eng_name,
        speciality,
        area,
        working_status,
        work_start_time: formatTimeWithTimezone(work_start_time),
        work_end_time: formatTimeWithTimezone(work_end_time),
      })
      .select()
      .single();

    if (engineerError) {
      console.error("Engineer insert error:", engineerError);
      // Rollback: delete user if insert fails
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(400).json({
        error: engineerError.message,
        details: engineerError.details,
        hint: engineerError.hint,
        code: engineerError.code,
      });
    }

    // 4️⃣ Success response
    res.json({
      success: true,
      message: "Registration successful",
      engineer: engineerData,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected registration error" });
  }
});
 
  /* ===========================
     ENGINEER LOGIN
  ============================*/
  app.post("/api/engineers/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password)
        return res
          .status(400)
          .json({ error: "Email and password are required" });

      const { data: authData, error: authError } =
        await supabase.auth.signInWithPassword({
          email,
          password,
        });
      if (authError || !authData.user)
        return res.json({ error: "Invalid login credentials" ,stauts: 401});

      const { data: profile, error: profError } = await supabase
        .from("engineers")
        .select("*")
        .eq("id", authData.user.id)
        .single();

      if (profError)
        return res.status(404).json({ error: "Engineer profile not found" });

      res.json({
        success: true,
        engineer: { ...profile, email: authData.user.email },
        session: {
          access_token: authData.session?.access_token,
          refresh_token: authData.session?.refresh_token,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Login failed" });
    }
  });

  /* ===========================
     ENGINEER FETCH JOBS (No admin auth required)
  ============================*/
  app.get("/api/engineers/jobs", async (req, res) => {
    try {
      const { engineer_id } = req.query;

      // Fetch customers with jobs data
      const { data: customers, error: custErr } = await supabase
        .from("customers")
        .select("*");

      if (custErr) {
        console.error("Error fetching customers:", custErr);
        return res.status(500).json({ error: "Failed to fetch customers" });
      }

      // Fetch all jobs
      const { data: jobs, error: jobErr } = await supabase
        .from("jobs")
        .select("*");

      if (jobErr) {
        console.error("Error fetching jobs:", jobErr);
        return res.status(500).json({ error: "Failed to fetch jobs" });
      }

      // Join customers with jobs data - SHOW ALL CUSTOMERS even if no job exists
      const jobsWithCustomers = (customers || []).map((customer) => {
        const job = (jobs || []).find((j) => j.customer_id === customer.id);

        // Use customer as primary, with job data overlaid
        return {
          ...customer,
          id: customer.id, // Always use customer ID as primary ID
          job_id: job?.id || null, // Actual job table ID (for internal tracking)
          status: job?.status || customer.status,
          job_status: job?.job_status || customer.status,
          engineer_uuid: job?.engineer_uuid || null,
          engineer_name: job?.engineer_name || null,
          scheduled_time: job?.scheduled_time || customer.scheduled_time,
        };
      });

      // Filter by engineer if specified
      if (engineer_id) {
        const filtered = jobsWithCustomers.filter(
          (j) => j.engineer_uuid === engineer_id || j.status === "new",
        );
        return res.json(filtered);
      }

      res.json(jobsWithCustomers);
    } catch (error) {
      console.error("Error fetching engineer jobs:", error);
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  /* ===========================
     ADMIN LOGIN (Protected by user_role table)
  ============================*/
  app.post("/api/admin/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password)
        return res
          .status(400)
          .json({ error: "Email and password are required" });

      // Step 1: Authenticate with Supabase Auth
      const { data: authData, error: authError } =
        await supabase.auth.signInWithPassword({
          email,
          password,
        });

      if (authError || !authData.user || !authData.session) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Step 2: Check user_roles table to verify admin access
      const { data: roleData, error: roleError } = await supabase
        .from("user_roles")
        .select("*")
        .eq("user_id", authData.user.id)
        .eq("role", "admin")
        .single();

      if (roleError || !roleData) {
        return res.status(403).json({
          error: "Access denied",
          message:
            "You do not have admin permissions. Only authorized administrators can access this panel.",
        });
      }

      // Step 3: Return session with access_token
      res.json({
        success: true,
        user_id: authData.user.id,
        role: roleData.role,
        email: authData.user.email,
        access_token: authData.session.access_token,
      });
    } catch (err) {
      console.error("Admin login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  });

  /* ===========================
     FETCH ENGINEER PROFILE
  ============================*/
  app.get("/api/engineers/profile/:userId", async (req, res) => {
    try {
      const { userId } = req.params;
      const { data, error } = await supabase
        .from("engineers")
        .select("*")
        .eq("id", userId)
        .single();
      if (error) return res.status(404).json({ error: "Profile not found" });
      res.json(data);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  /* ===========================
     FETCH AVAILABLE JOBS
  ============================*/
  app.get("/api/jobs/available", async (_req, res) => {
    try {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .eq("status", "new")
        .order("scheduled_time", { ascending: true });
      if (error) throw error;
      res.json(data || []);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch jobs" });
    }
  });

  /* ===========================
     GEOCODING VIA GOOGLE MAPS
  ============================*/
  app.post("/api/geocode", async (req, res) => {
    try {
      const { address, postcode } = req.body;
      if (!address && !postcode)
        return res.status(400).json({ error: "Missing address/postcode" });

      const query = postcode ? `${address}, ${postcode}, UK` : `${address}, UK`;
      const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        query,
      )}&key=${apiKey}`;
      const response = await fetch(url);
      const data = (await response.json()) as any;

      if (data.status !== "OK" || !data.results?.length)
        return res.status(404).json({ error: "Location not found" });

      const loc = data.results[0].geometry.location;
      res.json({
        latitude: loc.lat,
        longitude: loc.lng,
        formatted_address: data.results[0].formatted_address,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Geocoding failed" });
    }
  });

  /* ===========================
       ASSIGN JOB TO ENGINEER (ADMIN ONLY)
    ===========================*/
  app.post("/api/jobs/assign", async (req, res) => {
    try {
      const {
        customer_id,
        engineer_uuid,
        engineer_name,
        description,
        site_location,
        customer_latitude,
        customer_longitude,
        site_contact_name,
        site_contact_number,
        open_time, // optional from frontend
        Opening_Hours, // optional from customer record
        business_name,
        system_details,
      } = req.body;

      // ✅ Step 1: Fetch customer record to get schedule_time and Opening_Hours if not provided

      const { data: customer, error: custFetchErr } = await supabase
        .from("customers")
        .select("id, scheduled_time, Opening_Hours, status")
        .eq("id", Number(customer_id))
        .maybeSingle();

      if (custFetchErr) {
        console.error("Supabase fetch error:", custFetchErr);
        return res.status(500).json({ error: "Error fetching customer" });
      }

      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      // ✅ Ensure a valid open_time value
      const safeOpenTime =
        open_time || Opening_Hours || customer.Opening_Hours || "N/A";

      // ✅ Step 2: Build insert data, including schedule_time from customer
      const insertData = {
        customer_id,
        engineer_uuid,
        engineer_name,
        description: description || "Job assignment",
        site_location: site_location || "Location TBD",
        customer_latitude: customer_latitude || 0,
        customer_longitude: customer_longitude || 0,
        site_contact_naame: site_contact_name || "Contact TBD",
        site_contact_number: site_contact_number || "0000000000",
        job_status: "Assigned",
        open_time: safeOpenTime,
        business_name: business_name || "N/A",
        System_Details: system_details || "N/A",
        schedule_time: customer.scheduled_time || new Date().toISOString(), // ✅ added
      };

      // ✅ Step 3: Insert job record
      const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .insert(insertData)
        .select()
        .single();

      if (jobErr) throw jobErr;

      // ✅ Step 4: Update related customer record
      const { error: custUpdateErr } = await supabase
        .from("customers")
        .update({ status: "assigned", assigned_engineer: engineer_uuid })
        .eq("id", customer_id);

      if (custUpdateErr) throw custUpdateErr;

      res.json({ success: true, job });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Job assignment failed" });
    }
  });

  /* ===========================
     FETCH ALL JOBS (OPTIONAL FILTER BY ENGINEER) - ADMIN ONLY
  ============================*/
  app.get(
    "/api/fetch-jobs",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { engineer_id } = req.query;

        const { data: customers, error: custErr } = await supabase
          .from("customers")
          .select("*")
          .order("scheduled_time", { ascending: true });
        if (custErr) throw custErr;

        const { data: jobs, error: jobsErr } = await supabase
          .from("jobs")
          .select("*");
        if (jobsErr) throw jobsErr;

        // Fetch time tracking data for completion times
        const { data: timeTracking, error: timeErr } = await supabase
          .from("time_tracking")
          .select("job_id, end_time");
        if (timeErr) console.error("Error fetching time tracking:", timeErr);

        const jobsWithCustomers = customers.map((c) => {
          const assigned = jobs?.find((j) => j.customer_id === c.id);
          const timeEntry = timeTracking?.find(
            (t) => t.job_id === assigned?.id,
          );
          return {
            ...c,
            created_at: assigned?.created_at || c.created_at, // Use job created_at if available
            job_id: assigned?.id || null,
            job_status: assigned?.job_status || "new",
            completion_time: timeEntry?.end_time || null,
            engineer_uuid: assigned?.engineer_uuid || null,
            engineer_name: assigned?.engineer_name || null,
          };
        });

        const result = engineer_id
          ? jobsWithCustomers.filter((j) => j.engineer_uuid === engineer_id)
          : jobsWithCustomers;

        res.json(result);
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch jobs" });
      }
    },
  );

  /* ===========================
     DELETE JOB (ADMIN ONLY)
  ============================*/

  app.delete(
    "/api/delete-job/:job_id", // job_id actually means customer_id
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const customer_id = Number(req.params.job_id); // ensure numeric

        // Step 1: Fetch jobs linked to this customer
        const { data: jobs, error: jobFetchErr } = await supabase
          .from("jobs")
          .select("id, customer_id")
          .eq("customer_id", customer_id);

        if (jobFetchErr) throw jobFetchErr;

        const jobIds = jobs.map((j) => j.id);

        // Step 2: Delete time_tracking linked to those jobs
        if (jobIds.length > 0) {
          const { error: ttErr } = await supabase
            .from("time_tracking")
            .delete()
            .in("job_id", jobIds);
          if (ttErr) throw ttErr;
        }

        // Step 3: Delete jobs
        const { error: jobDeleteErr } = await supabase
          .from("jobs")
          .delete()
          .eq("customer_id", customer_id);
        if (jobDeleteErr) throw jobDeleteErr;

        // Step 4: Delete customer
        const { error: custDeleteErr } = await supabase
          .from("customers")
          .delete()
          .eq("id", customer_id);
        if (custDeleteErr) throw custDeleteErr;

        res.json({
          success: true,
          message: `Customer ${customer_id} and all related jobs deleted.`,
        });
      } catch (err) {
        console.error("Delete job error:", err);
        res.status(500).json({ error: "Failed to delete customer and jobs." });
      }
    },
  );

  /* ===========================
     EDIT JOB (ADMIN ONLY)
  ============================*/
  app.patch(
    "/api/edit-job/:job_id",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { job_id } = req.params;
        const {
          Business_Name,
          Site_Location,
          Description_of_Fault,
          Site_Contact_Name,
          Site_Contact_Number,
          Opening_Hours,
          Email_Address,
          System_Details,
          Job_Category,
          Priority,
          status,
          scheduled_time,
        } = req.body;

        // Step 1: Get customer_id from jobs table
        const { data: job, error: jobFetchErr } = await supabase
          .from("jobs")
          .select("customer_id")
          .eq("id", job_id)
          .single();

        if (jobFetchErr) {
          return res.status(404).json({ error: "Job not found" });
        }

        const customerId = job.customer_id;

        // Step 2: Update customers table
        if (customerId) {
          const { error: customerUpdateErr } = await supabase
            .from("customers")
            .update({
              Business_Name,
              Site_Location,
              Description_of_Fault,
              Site_Contact_Name,
              Site_Contact_Number,
              Opening_Hours,
              Email_Address,
              System_Details,
              Job_Category,
              Priority,
              status,
              scheduled_time,
            })
            .eq("id", customerId);

          if (customerUpdateErr) {
            throw customerUpdateErr;
          }
        }

        // Step 3: Update jobs table
        const { error: jobUpdateErr } = await supabase
          .from("jobs")
          .update({
            description: Description_of_Fault,
            site_location: Site_Location,
            site_contact_naame: Site_Contact_Name,
            site_contact_number: Site_Contact_Number,
            business_name: Business_Name,
            System_Details,
          })
          .eq("id", job_id);

        if (jobUpdateErr) {
          throw jobUpdateErr;
        }

        res.json({ success: true, message: "Job updated successfully" });
      } catch (err) {
        console.error("Edit job error:", err);
        res.status(500).json({ error: "Failed to update job" });
      }
    },
  );

  /* ===========================
     CALCULATE DISTANCE BETWEEN TWO COORDINATES (HAVERSINE FORMULA)
  ============================*/
  function calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371e3; // Earth radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }

  /* ===========================
     CHECK IF CURRENT TIME IS WITHIN OPENING HOURS
  ============================*/
  function isWithinOpeningHours(openingHours: string): boolean {
    if (!openingHours || openingHours === "Time not specified") return true;

    try {
      const now = new Date();
      const currentTime = now.toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      });

      // Parse various opening hours formats
      // e.g., "9 AM - 6 PM", "08:00-18:00", "9:00 AM to 6:00 PM"
      const timePattern = /(\d{1,2}):?(\d{2})?\s*(AM|PM)?/gi;
      const matches = Array.from(openingHours.matchAll(timePattern));

      if (matches.length >= 2) {
        let startHour = parseInt(matches[0][1]);
        let startMin = parseInt(matches[0][2] || "0");
        let endHour = parseInt(matches[1][1]);
        let endMin = parseInt(matches[1][2] || "0");

        // Convert to 24-hour format if AM/PM is specified
        if (matches[0][3]?.toUpperCase() === "PM" && startHour !== 12)
          startHour += 12;
        if (matches[0][3]?.toUpperCase() === "AM" && startHour === 12)
          startHour = 0;
        if (matches[1][3]?.toUpperCase() === "PM" && endHour !== 12)
          endHour += 12;
        if (matches[1][3]?.toUpperCase() === "AM" && endHour === 12)
          endHour = 0;

        const startTime = `${startHour.toString().padStart(2, "0")}:${startMin.toString().padStart(2, "0")}`;
        const endTime = `${endHour.toString().padStart(2, "0")}:${endMin.toString().padStart(2, "0")}`;

        return  currentTime >= startTime && currentTime <= endTime;
      }

      return true; // If can't parse, allow job to start
    } catch (error) {
      console.error("Error parsing opening hours:", error);
      return true; // If error, allow job to start
    }
  }

  async function getDrivingDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): Promise<number | null> {
    const apiKey = process.env.GOOGLE_API_KEY; // Store it in .env
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat1},${lon1}&destinations=${lat2},${lon2}&key=${apiKey}`;

    try {
      const response = await axios.get(url);
      
      if (!response.data || !response.data.rows || response.data.rows.length === 0) {
        console.error("Google API returned invalid data structure");
        return null;
      }

      const element = response.data.rows[0].elements[0];

      if (element.status === "OK" && element.distance && element.distance.value !== undefined) {
        // Distance in meters
        return element.distance.value;
      } else if (element.status === "ZERO_RESULTS") {
        // When origin and destination are the same or very close
        return 0; // Return 0 distance (within 1km limit)
      } else {
        console.error("Google API element status:", element.status);
        console.error("Full element:", element);
        return null;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      console.error("Error fetching driving distance:", errorMessage);
      return null;
    }
  }

  /* ===========================
     GET ACTIVE JOB FOR ENGINEER (FOR STATE RESTORATION)
  ============================*/
  app.get("/api/engineers/:engineerId/active-job", async (req, res) => {
    try {
      const { engineerId } = req.params;

      // Find active time tracking entry (no end_time)
      const { data: activeEntry, error } = await supabase
        .from("time_tracking")
        .select("job_id, start_time, engineer_id")
        .eq("engineer_id", engineerId)
        .is("end_time", null)
        .order("start_time", { ascending: false })
        .limit(1)
        .single();

      // Handle time tracking query errors properly
      if (error) {
        // PGRST116 = no rows returned (no active timer) - this is expected
        if (error.code === 'PGRST116') {
          return res.status(404).json({ message: "No active job found" });
        }
        // For other errors (network, auth, database issues), return 500
        console.error(`❌ Database error fetching time tracking for engineer ${engineerId}:`, error);
        return res.status(500).json({ error: "Database error fetching active job" });
      }

      if (!activeEntry) {
        return res.status(404).json({ message: "No active job found" });
      }

      // Check the job's status - don't restore timer for "Quoted" or "Approved" jobs
      const { data: jobData, error: jobStatusError } = await supabase
        .from("jobs")
        .select("job_status")
        .eq("id", activeEntry.job_id)
        .single();

      // Handle job status lookup errors carefully
      if (jobStatusError) {
        // PGRST116 = no rows returned (job was deleted) - treat as no active job
        if (jobStatusError.code === 'PGRST116') {
          return res.status(404).json({ message: "No active job found" });
        }
        // For other errors (network, auth, etc.), return 500 but log for monitoring
        console.error(`❌ Database error fetching job status for ${activeEntry.job_id}:`, jobStatusError);
        return res.status(500).json({ error: "Database error fetching job status" });
      }

      const jobStatus = jobData?.job_status?.toLowerCase() || '';
      
      // Don't return active job if it's in quote workflow (waiting for approval or already approved)
      if (jobStatus === 'quoted' || jobStatus === 'approved') {
        return res.status(404).json({ message: "No active job found" });
      }

      res.json(activeEntry);
    } catch (err) {
      console.error("❌ Unexpected error in /active-job endpoint:", err);
      // Return 500 for unexpected errors so they can be monitored
      return res.status(500).json({ error: "Failed to fetch active job" });
    }
  });

  /* ===========================
     START JOB TIMER WITH LOCATION & TIME VERIFICATION
  ============================*/
  app.post("/api/start-job", async (req, res) => {
    try {
      const { job_id, engineer_id, engineer_latitude, engineer_longitude } =
        req.body;
      if (!job_id || !engineer_id)
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });

      // Get job details including location coordinates and status
      const { data: jobData } = await supabase
        .from("jobs")
        .select(
          "customer_id, customer_latitude, customer_longitude, site_location, job_status",
        )
        .eq("id", job_id)
        .single();
      console.log("Job data:", jobData);

      if (!jobData) {
        return res.status(404).json({ error: "Job not found" });
      }

      // Prevent starting jobs with "Quoted" status (server-side validation)
      if (jobData.job_status?.toLowerCase() === "quoted") {
        return res.status(403).json({
          error:
            "Cannot start job with Quoted status. Please wait for admin approval.",
        });
      }

      // Get customer details for Opening_Hours
      const { data: customerData } = await supabase
        .from("customers")
        .select("Opening_Hours")
        .eq("id", jobData.customer_id)
        .single();

      if (!customerData) {
        return res.status(404).json({ error: "Customer not found" });
      }

      // Combine job location with customer opening hours
      const locationData = {
        latitude: jobData.customer_latitude,
        longitude: jobData.customer_longitude,
        Site_Location: jobData.site_location,
        Opening_Hours: customerData.Opening_Hours,
      };

      console.log("Location data:", locationData);
      // STRICT LOCATION VERIFICATION - MANDATORY!
      if (!engineer_latitude || !engineer_longitude) {
        return res.status(400).json({
          error: "Location required",
          message:
            "⚠️ Please enable location services to start the job. Location verification is mandatory.",
        });
      }

      if (!locationData.latitude || !locationData.longitude) {
        return res.status(400).json({
          error: "Customer location missing",
          message: `⚠️ Customer location not available for ${locationData.Site_Location}. Please contact admin to geocode this address.`,
        });
      }

      // Calculate distance - MUST be within 1000 meters (1km)
      let distance: number | null = null;

      // Short-circuit: If coordinates are virtually identical, consider engineer at location
      const latDiff = Math.abs(engineer_latitude - Number(locationData.latitude));
      const lonDiff = Math.abs(engineer_longitude - Number(locationData.longitude));
      
      if (latDiff < 0.0001 && lonDiff < 0.0001) {
        // Coordinates are essentially the same (within ~11 meters)
        console.log("✅ Engineer coordinates match job location - skipping Google API call");
        distance = 0;
      } else {
        // Use Google Distance Matrix API for driving distance
        distance = await getDrivingDistance(
          engineer_latitude,
          engineer_longitude,
          Number(locationData.latitude),
          Number(locationData.longitude),
        );

        // Fallback to Haversine if Google API fails
        if (distance === null) {
          console.log("⚠️ Google API returned null, falling back to Haversine distance");
          distance = calculateDistance(
            engineer_latitude,
            engineer_longitude,
            Number(locationData.latitude),
            Number(locationData.longitude),
          );
        }
      }

      if (distance === null) {
        return res.status(400).json({
          error: "Distance check failed",
          message: "⚠️ Unable to verify distance. Please try again.",
        });
      }

      console.log(
        `Location check: Engineer at (${engineer_latitude}, ${engineer_longitude}), Customer at (${locationData.latitude}, ${locationData.longitude}), Distance: ${Math.round(distance)}m`,
      );

      if (distance > 1000) {
        return res.status(400).json({
          error: "Location verification failed",
          message: `⚠️ You must be within 1km of the job site to start. You're currently ${(distance / 1000).toFixed(2)}km away. Please move closer to the location.`,
          distance: Math.round(distance),
          distanceKm: (distance / 1000).toFixed(2),
        });
      }

      // Verify time window
      if (locationData.Opening_Hours) {
        const withinHours = isWithinOpeningHours(locationData.Opening_Hours);
        if (!withinHours) {
          return res.status(400).json({
            error: "Time verification failed",
            message: `This job should be started during customer's opening hours: ${locationData.Opening_Hours}`,
            opening_hours: locationData.Opening_Hours,
          });
        }
      }

      const startTime = new Date().toISOString();
      const { data, error } = await supabase
        .from("time_tracking")
        .insert({
          job_id,
          engineer_id,
          start_time: startTime,
        })
        .select()
        .single();
      if (error) throw error;

      await supabase
        .from("jobs")
        .update({ job_status: "In Progress" })
        .eq("id", job_id);
      res.json({ success: true, time_entry: data });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to start job" });
    }
  });

  /* ===========================
     PAUSE JOB TIMER (Frontend-only tracking)
  ============================*/
  app.post("/api/pause-job", async (req, res) => {
    try {
      const { job_id, engineer_id } = req.body;
      if (!job_id || !engineer_id)
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });

      // Verify active job exists
      const { data: entries } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .limit(1);

      if (!entries?.length)
        return res.status(404).json({ error: "Active time entry not found" });

      const pauseTime = new Date().toISOString();
      res.json({ success: true, paused_at: pauseTime });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to pause job" });
    }
  });

  /* ===========================
     RESUME JOB TIMER (Frontend-only tracking)
  ============================*/
  app.post("/api/resume-job", async (req, res) => {
    try {
      const { job_id, engineer_id } = req.body;
      if (!job_id || !engineer_id)
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });

      // Verify active job exists
      const { data: entries } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .limit(1);

      if (!entries?.length)
        return res.status(404).json({ error: "Active time entry not found" });

      const resumeTime = new Date().toISOString();
      res.json({ success: true, resumed_at: resumeTime });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to resume job" });
    }
  });

  /* ===========================
     VERIFY LOCATION DURING JOB (FOR AUTO-COMPLETION)
  ============================*/
  app.post("/api/verify-location", async (req, res) => {
    try {
      const { job_id, engineer_id, engineer_latitude, engineer_longitude } =
        req.body;
      if (!job_id || !engineer_id || !engineer_latitude || !engineer_longitude)
        return res.status(400).json({ error: "Missing required parameters" });

      // Get job location
      const { data: jobData } = await supabase
        .from("jobs")
        .select("customer_id")
        .eq("id", job_id)
        .single();

      if (!jobData) {
        return res.status(404).json({ error: "Job not found" });
      }

      const { data: customerData } = await supabase
        .from("customers")
        .select("latitude, longitude")
        .eq("id", jobData.customer_id)
        .single();

      if (!customerData || !customerData.latitude || !customerData.longitude) {
        return res.json({ within_range: true }); // If no location data, don't auto-complete
      }

      const distance = calculateDistance(
        engineer_latitude,
        engineer_longitude,
        customerData.latitude,
        customerData.longitude,
      );

      res.json({
        within_range: distance <= 500,
        distance: Math.round(distance),
        threshold: 500,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to verify location" });
    }
  });

  /* ===========================
     END JOB, UPLOAD IMAGE, TRIGGER WEBHOOK
  ============================*/
  app.post("/api/end-job", async (req, res) => {
    try {
      const { job_id, engineer_id, image_data, products = [] } = req.body;
      if (!job_id || !engineer_id)
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });

      const endTime = new Date().toISOString();
      const { data: entries } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .limit(1);

      if (!entries?.length)
        return res.status(404).json({ error: "Active time entry not found" });

      const entry = entries[0];

      // Calculate total working time
      const totalElapsed = Math.floor(
        (Date.now() - new Date(entry.start_time).getTime()) / 1000,
      );
      const durationMinutes = Math.floor(totalElapsed / 60);

      await supabase
        .from("time_tracking")
        .update({
          end_time: endTime,
          duration_minutes: durationMinutes,
        })
        .eq("id", entry.id);

      let imageUrl = null;
      if (image_data) {
        const fileName = `job-${job_id}-${Date.now()}.jpg`;
        const { error: upErr } = await supabase.storage
          .from("job-photos")
          .upload(fileName, Buffer.from(image_data.split(",")[1], "base64"), {
            contentType: "image/jpeg",
          });
        if (!upErr) {
          const { data: pub } = supabase.storage
            .from("job-photos")
            .getPublicUrl(fileName);
          imageUrl = pub.publicUrl;
        }
      }

      // Update job status to Completed
      const { error: jobUpdateErr } = await supabase
        .from("jobs")
        .update({ job_status: "Completed" })
        .eq("id", job_id);

      if (jobUpdateErr) {
        console.error("Failed to update job status:", jobUpdateErr);
        throw new Error("Failed to complete job");
      }

      const { data: jobData } = await supabase
        .from("jobs")
        .select("customer_id")
        .eq("id", job_id)
        .single();
      if (jobData) {
        await supabase
          .from("customers")
          .update({ status: "completed" })
          .eq("id", jobData.customer_id);
      }

      if (process.env.N8N_WEBHOOK_URL) {
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id,
            engineer_id,
            duration_minutes: durationMinutes,
            end_time: endTime,
            image_url: imageUrl,
            products_used: products,
          }),
        }).catch((e) => console.error("Webhook error:", e));
      }

      res.json({
        success: true,
        duration_minutes: durationMinutes,
        image_url: imageUrl,
        products_count: products.length,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to end job" });
    }
  });

  /* ===========================
     UPLOAD MULTIPLE IMAGES TO IMAGEKIT
  ============================*/
  app.post("/api/upload-images-imagekit",
    upload.array("images", 10),
    async (req, res) => {
      try {
        const files = req.files as Express.Multer.File[];
        const job_id = req.body.job_id;

        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No images provided" });
        }

        console.log(
          `Uploading ${files.length} images to ImageKit for job ${job_id}...`,
        );

        const uploadedUrls: string[] = [];

        for (let i = 0; i < files.length; i++) {
          const file = files[i];

          // Convert buffer to base64
          const base64Data = file.buffer.toString("base64");

          // Upload to ImageKit
          const result = await imagekit.upload({
            file: base64Data,
            fileName: `job-${job_id}-${Date.now()}-${i}-${file.originalname}`,
            folder: "/job-quotes",
          });

          uploadedUrls.push(result.url);
          console.log(
            `✅ Uploaded image ${i + 1}/${files.length}: ${result.url}`,
          );
        }

        res.json({ success: true, urls: uploadedUrls });
      } catch (err) {
        console.error("ImageKit upload error:", err);
        res.status(500).json({ error: "Failed to upload images" });
      }
    },
  );

  /* ===========================
     SUBMIT JOB QUOTE WITH IMAGES, PRODUCTS, NOTES
  ============================*/
  app.post("/api/submit-job-quote", async (req, res) => {
    try {
      const { job_id, image_urls, product_names, notes, engineer_id } =
        req.body;

      if (!job_id) {
        return res.status(400).json({ error: "Job ID is required" });
      }

      console.log("Submitting quote for job:", job_id);
      console.log("Image URLs:", image_urls);
      console.log("Products:", product_names);
      console.log("Notes:", notes);

      // STEP 0: Check job status to prevent duplicate quote submissions
      const { data: existingJob } = await supabase
        .from("jobs")
        .select("job_status")
        .eq("id", job_id)
        .single();

      const currentStatus = existingJob?.job_status?.toLowerCase() || '';
      if (currentStatus === 'quoted' || currentStatus === 'approved') {
        console.log(`⚠️ Quote already submitted for job ${job_id} (status: ${currentStatus})`);
        return res.status(400).json({ 
          error: "Quote already submitted",
          message: `This job already has status "${existingJob?.job_status}". Cannot submit duplicate quote.`
        });
      }

      // STEP 1: End the active time tracking session for this quote
      const { data: timeEntry, error: timeQueryErr } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .limit(1);

      if (timeQueryErr) {
        console.error("⚠️ Error fetching time tracking:", timeQueryErr);
      }

      let timeData = null;
      if (timeEntry && timeEntry.length > 0) {
        const entry = timeEntry[0];
        const endTime = new Date().toISOString();
        const startTime = new Date(entry.start_time);
        const durationMinutes = Math.floor(
          (new Date(endTime).getTime() - startTime.getTime()) / 60000
        );

        console.log(`⏱️ Ending time tracking for job ${job_id}: ${durationMinutes} minutes`);

        // Update time tracking with end time
        const { error: timeUpdateErr } = await supabase
          .from("time_tracking")
          .update({
            end_time: endTime,
            duration_minutes: durationMinutes,
          })
          .eq("id", entry.id);

        if (timeUpdateErr) {
          console.error("❌ Error ending time tracking:", timeUpdateErr);
          // Don't fail the quote submission if time tracking update fails
          // The job update is more critical
        } else {
          console.log(`✅ Time tracking ended successfully: ${durationMinutes} minutes`);
          timeData = {
            start_time: entry.start_time,
            end_time: endTime,
            duration_minutes: durationMinutes,
          };
        }
      } else {
        console.log(`ℹ️ No active time tracking found for job ${job_id} - may have been ended previously`);
      }

      // STEP 2: Update job in Supabase with quote data and change status to Quoted
      // Use conditional update with EXPLICIT status check for better concurrency control
      console.log(`📝 Updating job ${job_id} status to "Quoted"`);
      const { data: updatedJob, error: updateError, count } = await supabase
        .from("jobs")
        .update({
          job_status: "Quoted",
          image_urls: image_urls || [],
          product_names: product_names || [],
          notes: notes || "",
        })
        .eq("id", job_id)
        .eq("job_status", "In Progress") // Explicit check: only update if currently "In Progress"
        .select()
        .single();

      // Handle update failure - rollback time tracking if needed
      if (updateError) {
        console.error("❌ CRITICAL: Failed to update job status:", updateError);
        
        // If time tracking was ended but job update failed, attempt to reopen timer
        if (timeData) {
          console.log("⚠️ Attempting to reopen time tracking due to job update failure");
          const { error: rollbackError } = await supabase
            .from("time_tracking")
            .update({ end_time: null, duration_minutes: null })
            .eq("job_id", job_id)
            .eq("engineer_id", engineer_id)
            .eq("end_time", timeData.end_time); // Only reopen if it's the one we just closed
          
          if (rollbackError) {
            console.error("❌ Failed to rollback time tracking:", rollbackError);
          } else {
            console.log("✅ Time tracking reopened after job update failure");
          }
        }
        
        throw new Error(`Failed to update job status: ${updateError.message}`);
      }

      // No rows updated means job was not "In Progress" (concurrent submission or wrong status)
      if (!updatedJob) {
        console.log("⚠️ Job update returned no rows - job may already be Quoted/Approved");
        return res.status(409).json({ 
          error: "Quote already submitted",
          message: "This job is not in 'In Progress' status. It may have been quoted already."
        });
      }

      console.log("✅ Job updated with quote data and status changed to 'Quoted'");

      // STEP 3: Trigger n8n webhook with quote data AND time tracking data
      const webhookUrl =
        "https://keptcoldhvac.app.n8n.cloud/webhook/job-quote-webhook";

      try {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id,
            engineer_id,
            image_urls,
            product_names,
            notes,
            status: "Quote",
            timestamp: new Date().toISOString(),
            time_tracking: timeData, // Include time spent before quote submission
          }),
        });
        console.log("✅ Quote webhook triggered successfully");
      } catch (webhookErr) {
        console.error("Quote webhook error:", webhookErr);
        // Don't fail the request if webhook fails
      }

      res.json({ success: true, job: updatedJob });
    } catch (err) {
      console.error("Error submitting quote:", err);
      res.status(500).json({ error: "Failed to submit quote" });
    }
  });

  /* ===========================
     FETCH LEADS FROM MAPS_LEADS TABLE - ADMIN ONLY
  ============================*/
  app.get("/api/leads", requireAdminAuth, async (req: AdminRequest, res) => {
    try {
      const { data, error } = await supabase
        .from("maps_leads")
        .select("*")
        .order("id", { ascending: false })
        .limit(50);

      if (error) throw error;
      res.json(data || []);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  /* ===========================
   LEADS SUMMARY - ADMIN ONLY
=========================== */
app.get("/api/leads-summary", requireAdminAuth, async (req: AdminRequest, res) => {
  try {
    console.log("Fetching leads summary from Supabase...");

    // Total customers
    const { count: totalCustomers, error: customerError } = await supabase
      .from("companies")
      .select("*", { count: "exact", head: true }); // only count, no data

    if (customerError) {
      console.error("Error fetching customer count:", customerError.message);
      return res.status(500).json({ error: customerError.message });
    }

    // Total pending leads
    const { count: pendingLeads, error: pendingError } = await supabase
      .from("companies")
      .select("*", { count: "exact", head: true })
      .eq("status", "Pending");

    if (pendingError) {
      console.error("Error fetching pending leads count:", pendingError.message);
      return res.status(500).json({ error: pendingError.message });
    }

    res.json({
      totalCustomers: totalCustomers || 0,
      pendingLeads: pendingLeads || 0,
    });

    console.log("Leads summary sent:", { totalCustomers, pendingLeads });
  } catch (err) {
    console.error("Unexpected error in /api/leads-summary:", err);
    res.status(500).json({ error: "Failed to fetch leads summary" });
  }
});


  /* ===========================
     INVOICES MANAGEMENT - ADMIN ONLY
  ============================*/
  app.get("/api/invoices", requireAdminAuth, async (req: AdminRequest, res) => {
    try {
      console.log("Fetching invoices from Supabase...");

      const { data, error } = await supabase
        .from("Invoice")
        .select("*")
        .order("created_at", { ascending: false });

        console.log("Supabase response:", { data, error });
      if (error) {
        console.error("Error fetching invoices:", error.message);
        return res.status(500).json({ error: error.message });
      }

      console.log(`Fetched ${data?.length || 0} invoices.`);
      res.json(data || []);
    } catch (err) {
      console.error("Unexpected error in /api/invoices:", err);
      res.status(500).json({ error: "Failed to fetch invoices" });
    }
  });

  app.patch("/api/invoices/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { changes_needed, status } = req.body;

      const updateData: any = {};
      if (changes_needed !== undefined)
        updateData.changes_needed = changes_needed;
      if (status !== undefined) updateData.status = status;

      const { data, error } = await supabase
        .from("Invoice")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      res.json(data);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update invoice" });
    }
  });

  /* ===========================
     QUOTES MANAGEMENT - ADMIN ONLY
  ============================*/
  app.get("/api/quotes", requireAdminAuth, async (req: AdminRequest, res) => {
    try {
  
      console.log("Fetching all quotes from Supabase...");

      const { data, error, count } = await supabase
        .from("quotes")
        .select("*", { count: "exact" })
        .order("id", { ascending: false });

      if (error) {
        console.error("Supabase error fetching quotes:", error);
        return res.status(500).json({
          success: false,
          error: "Failed to fetch quotes",
          details: error.message,
        });
      }

      console.log(
        `Fetched ${data?.length || 0} quotes (Total count: ${count})`,
      );
      return res.json({
        success: true,
        count,
        quotes: data || [],
      });
    } catch (err) {
      console.error("Error in /api/quotes:", err);
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
      });
    }
  });

  app.patch(
    "/api/quotes/:id",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { id } = req.params;
        const { p_prices } = req.body;

        if (!id || isNaN(Number(id))) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid quote ID" });
        }
        if (!p_prices) {
          return res
            .status(400)
            .json({ success: false, error: "Missing p_prices field" });
        }

        console.log(`Updating quote ID: ${id} with prices:`, p_prices);

        const { data: updatedQuote, error: updateError } = await supabase
          .from("quotes")
          .update({ p_prices })
          .eq("id", Number(id))
          .select()
          .single();

        if (updateError) {
          console.error("Supabase update error:", updateError);
          throw updateError;
        }

        console.log("Quote updated successfully:", updatedQuote);

        // Send to n8n webhook (non-blocking)
        const webhookUrl =
          "https://keptcoldhvac.app.n8n.cloud/webhook/quote-sent";
        try {
          const webhookResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updatedQuote),
          });

          if (!webhookResponse.ok) {
            console.error(
              "Webhook failed:",
              webhookResponse.status,
              webhookResponse.statusText,
            );
          } else {
            console.log("✅ Webhook sent successfully to:", webhookUrl);
          }
        } catch (webhookError) {
          console.error("Error sending webhook:", webhookError);
        }

        return res.json({
          success: true,
          message: "Quote updated successfully",
          quote: updatedQuote,
        });
      } catch (err) {
        console.error("Error in PATCH /api/quotes/:id:", err);
        return res.status(500).json({
          success: false,
          error: "Failed to update quote",
        });
      }
    },
  );

  /* ===========================
     ENGINEER QUOTES - READ ONLY (AUTHENTICATED)
  ============================*/
  app.get("/api/engineer-quotes", async (req, res) => {
    try {
      // Get auth token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: "No authentication token provided",
        });
      }

      const token = authHeader.substring(7); // Remove "Bearer " prefix
      
      // Verify engineer authentication and get user
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser(token);

      if (authError || !user) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized",
          message: "Invalid or expired authentication token",
        });
      }

      // Use the authenticated user's ID (server-derived, secure)
      const engineerId = user.id;
      console.log(`Fetching quotes for authenticated engineer: ${engineerId}`);

      // Fetch quotes for this engineer only
      const { data, error } = await supabase
        .from("quotes")
        .select("*")
        .eq("engineer_id", engineerId)
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Supabase error fetching engineer quotes:", error);
        return res.status(500).json({
          success: false,
          error: "Failed to fetch quotes",
          details: error.message,
        });
      }

      console.log(`Fetched ${data?.length || 0} quotes for engineer ${engineerId}`);
      return res.json({
        success: true,
        quotes: data || [],
      });
    } catch (err) {
      console.error("Error in /api/engineer-quotes:", err);
      return res.status(500).json({
        success: false,
        error: "Internal Server Error",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
