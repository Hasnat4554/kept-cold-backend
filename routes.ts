import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { supabase, supabaseAuth } from "./supabase.js";
import { engineerRegistrationSchema, jobs } from "./lib/schema.js";
import fetch from "node-fetch"; // ✅ ensure available in package.json
import axios from "axios";
import ImageKit from "imagekit";
import multer from "multer";
import { isJobCompleted, isJobInProgress } from "lib/helperFuntions.js";

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
export async function requireAdminAuth(
  req: AdminRequest,
  res: Response,
  next: NextFunction
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
      const { data: authData, error: authError } =
        await supabase.auth.admin.createUser({
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
        return res.json({ error: "Invalid login credentials", stauts: 401 });

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
      const { page = "1", limit = "20", engineer_id = "" } = req.query;

      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const offset = (pageNum - 1) * limitNum;

      // 1. AVAILABLE/NEW JOBS (unassigned)
      const { data: availableCustomers, count: availableCount } = await supabase
        .from("customers")
        .select("*", { count: "exact" })
        .eq("status", "new")
        .order("scheduled_time", { ascending: true })
        .range(offset, offset + limitNum - 1);

      // Format available jobs
      const availableJobs = (availableCustomers || []).map((customer) => ({
        ...customer,
        job_id: null,
        job_status: "new",
        status: "new",
        engineer_uuid: null,
        engineer_name: null,
        engineerUploadImages: [],
        duration_minutes: 0,
        duration_formatted: null,
        accumulated_minutes: 0,
      }));

      // Initialize arrays for engineer jobs
      let assignedJobs: any[] = [];
      let completedJobs: any[] = [];
      let assignedCount = 0;
      let completedCount = 0;

      // Only fetch engineer jobs if engineer_id is provided
      if (engineer_id) {
        // 2. ENGINEER'S ASSIGNED/ACTIVE JOBS - FIX: Use ilike for case-insensitive
        const { data: activeData, count: activeCount, error: activeError } = await supabase
          .from("jobs")
          .select(`*, customer:customer_id (*)`, { count: "exact" })
          .eq("engineer_uuid", engineer_id)
          .not("job_status", "ilike", "completed")
          .not("job_status", "ilike", "invoiced")
          .not("job_status", "ilike", "paid")
          .not("job_status", "ilike", "1streminder")
          .order("created_at", { ascending: false })
          .range(offset, offset + limitNum - 1);

        // ADD THESE DEBUG LINES:
        if (activeError) {
          console.error("❌ Active jobs query error:", activeError);
        }
        console.log("Active jobs fetched:", activeData?.length,);

        // 3. ENGINEER'S COMPLETED JOBS - FIX: Use or with ilike for case-insensitive
        const { data: completedData, count: compCount } = await supabase
          .from("jobs")
          .select(
            `
          *,
          customer:customer_id (*)
        `,
            { count: "exact" }
          )
          .eq("engineer_uuid", engineer_id)
          .or(
            "job_status.ilike.completed,job_status.ilike.invoiced,job_status.ilike.paid,job_status.ilike.1streminder"
          )
          .order("created_at", { ascending: false })
          .range(offset, offset + limitNum - 1);

        console.log("Completed jobs fetched:", completedData?.length);

        // Get time tracking data for engineer's jobs
        const jobIds = [
          ...(activeData || []).map((j) => j.id),
          ...(completedData || []).map((j) => j.id),
        ].filter(Boolean);

        let timeTrackingData: any[] = [];
        if (jobIds.length > 0) {
          const { data: timeTracking } = await supabase
            .from("time_tracking")
            .select("job_id, duration_minutes, accumulated_minutes, is_paused")
            .in("job_id", jobIds);
          timeTrackingData = timeTracking || [];
        }

        // Format assigned jobs
        assignedJobs = (activeData || []).map((job) => {
          const timeData = timeTrackingData.find((t) => t.job_id === job.id);
          const durationMinutes = timeData?.duration_minutes || 0;
          const hours = Math.floor(durationMinutes / 60);
          const minutes = durationMinutes % 60;

          return {
            ...job.customer,
            job_id: job.id,
            job_status: job.job_status,
            status: job.job_status,
            engineer_uuid: job.engineer_uuid,
            engineer_name: job.engineer_name,
            scheduled_time: job.scheduled_time || job.customer?.scheduled_time,
            engineerUploadImages: job.image_urls || [],
            duration_minutes: durationMinutes,
            duration_formatted:
              durationMinutes > 0
                ? hours > 0
                  ? `${hours}h ${minutes}m`
                  : `${minutes}m`
                : null,
            accumulated_minutes: timeData?.accumulated_minutes || 0,
            is_paused: timeData?.is_paused || false,

          };
        });

        // Format completed jobs - ensure consistent status
        completedJobs = (completedData || []).map((job) => {
          const timeData = timeTrackingData.find((t) => t.job_id === job.id);
          const durationMinutes = timeData?.duration_minutes || 0;
          const hours = Math.floor(durationMinutes / 60);
          const minutes = durationMinutes % 60;

          return {
            ...job.customer,
            job_id: job.id,
            job_status: job.job_status || "Completed", // Use capital C for consistency
            status: job.job_status || "Completed",
            engineer_uuid: job.engineer_uuid,
            engineer_name: job.engineer_name,
            scheduled_time: job.scheduled_time || job.customer?.scheduled_time,
            engineerUploadImages: job.image_urls || [],
            duration_minutes: durationMinutes,
            duration_formatted:
              durationMinutes > 0
                ? hours > 0
                  ? `${hours}h ${minutes}m`
                  : `${minutes}m`
                : null,
            accumulated_minutes: timeData?.accumulated_minutes || 0,
          };
        });

        assignedCount = activeCount || 0;
        completedCount = compCount || 0;
      }

      // Return separate arrays - NO MIXING!
      res.json({
        availableJobs: availableJobs,
        assignedJobs: assignedJobs,
        completedJobs: completedJobs,
        counts: {
          available: availableCount || 0,
          assigned: assignedCount,
          completed: completedCount,
        },
        pagination: {
          page: pageNum,
          limit: limitNum,
          hasMore:
            pageNum <
            Math.ceil(
              Math.max(
                (availableCount || 0) / limitNum,
                assignedCount / limitNum,
                completedCount / limitNum
              )
            ),
        },
      });
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

      // Step 3: Return session with access_token and refresh_token
      res.json({
        success: true,
        user_id: authData.user.id,
        role: roleData.role,
        email: authData.user.email,
        access_token: authData.session.access_token,
        refresh_token: authData.session.refresh_token,
      });
    } catch (err) {
      console.error("Admin login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  });

  /* ===========================
     ADMIN TOKEN REFRESH
  ============================*/
  app.post("/api/admin/refresh-token", async (req, res) => {
    try {
      const { refresh_token } = req.body;

      if (!refresh_token) {
        return res.status(400).json({ error: "Refresh token required" });
      }

      // Use Supabase to refresh the session
      const { data, error } = await supabase.auth.refreshSession({
        refresh_token,
      });

      if (error || !data.session) {
        return res.status(401).json({
          error: "Invalid or expired refresh token",
          message: "Please log in again",
        });
      }

      // Verify user still has admin role
      const { data: roleData, error: roleError } = await supabase
        .from("user_roles")
        .select("*")
        .eq("user_id", data.session.user.id)
        .eq("role", "admin")
        .single();

      if (roleError || !roleData) {
        return res.status(403).json({
          error: "Access denied",
          message: "Admin permissions revoked",
        });
      }

      res.json({
        success: true,
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    } catch (err) {
      console.error("Admin token refresh error:", err);
      res.status(500).json({ error: "Token refresh failed" });
    }
  });

  /* ===========================
     ENGINEER TOKEN REFRESH
  ============================*/
  app.post("/api/refresh-token", async (req, res) => {
    try {
      const { refresh_token } = req.body;

      if (!refresh_token) {
        return res.status(400).json({ error: "Refresh token required" });
      }

      // Use Supabase to refresh the session
      const { data, error } = await supabase.auth.refreshSession({
        refresh_token,
      });

      if (error || !data.session) {
        return res.status(401).json({
          error: "Invalid or expired refresh token",
          message: "Please log in again",
        });
      }

      // Verify user is still an engineer
      const { data: engineerData, error: engineerError } = await supabase
        .from("engineers")
        .select("*")
        .eq("id", data.session.user.id)
        .single();

      if (engineerError || !engineerData) {
        return res.status(403).json({
          error: "Access denied",
          message: "Engineer profile not found",
        });
      }

      res.json({
        success: true,
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
    } catch (err) {
      console.error("Engineer token refresh error:", err);
      res.status(500).json({ error: "Token refresh failed" });
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
      const { customer_id, address, postcode } = req.body;

      if (!address && !postcode) {
        return res.status(400).json({ error: "Missing address/postcode" });
      }

      // ✅ STEP 1: Check if customer already has geocoded data in DB
      if (customer_id) {
        const { data: existingCustomer } = await supabase
          .from("customers")
          .select("id, latitude, longitude, formatted_address")
          .eq("id", customer_id)
          .single();

        // ✅ If coordinates exist, return them immediately (no API call!)
        if (existingCustomer?.latitude && existingCustomer?.longitude) {
          console.log(
            `✅ Using cached coordinates for customer ${customer_id}`
          );
          return res.json({
            latitude: existingCustomer.latitude,
            longitude: existingCustomer.longitude,
            formatted_address:
              existingCustomer.formatted_address || `${address}, ${postcode}`,
            cached: true, // Flag to indicate this was from DB
          });
        }
      }

      // ✅ STEP 2: No cached data - call Google Geocoding API
      console.log(
        `🌍 Geocoding address for customer ${customer_id || "unknown"
        }: ${address}, ${postcode}`
      );

      const query = postcode ? `${address}, ${postcode}, UK` : `${address}, UK`;
      const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        query
      )}&key=${apiKey}`;

      const response = await fetch(url);
      const data = (await response.json()) as any;

      if (data.status !== "OK" || !data.results?.length) {
        return res.status(404).json({ error: "Location not found" });
      }

      const loc = data.results[0].geometry.location;
      const formattedAddress = data.results[0].formatted_address;

      // ✅ STEP 3: Store geocoded coordinates in DB for future use
      if (customer_id) {
        const { error: updateError } = await supabase
          .from("customers")
          .update({
            latitude: loc.lat,
            longitude: loc.lng,
            formatted_address: formattedAddress,
          })
          .eq("id", customer_id);

        if (updateError) {
          console.error("❌ Failed to cache geocode data:", updateError);
        } else {
          console.log(
            `✅ Stored coordinates in DB for customer ${customer_id}`
          );
        }
      }

      // ✅ STEP 4: Return fresh geocoded data
      res.json({
        latitude: loc.lat,
        longitude: loc.lng,
        formatted_address: formattedAddress,
        cached: false, // Flag to indicate this was a fresh API call
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
        const {
          engineer_id,
          page = "1",
          limit = "10",
          search = "",
          status = "",
          dateFrom = "",
          excludeStatus = "", // New parameter
          dateTo = "",
        } = req.query;

        const pageNum = parseInt(page as string);
        const limitNum = parseInt(limit as string);
        const offset = (pageNum - 1) * limitNum;

        // Build the base query
        let customersQuery = supabase
          .from("customers")
          .select("*", { count: "exact" });

        console.log('cutomer qyert', customersQuery)
        // Apply search filter if provided
        if (search) {
          customersQuery = customersQuery.or(
            `Business_Name.ilike.%${search}%,Site_Location.ilike.%${search}%,id.eq.${isNaN(Number(search)) ? 0 : search
            }`
          );
        }

        // Apply status filter if provided
        if (status) {
          customersQuery = customersQuery.eq("status", status);
        }
        console.log("Exclude Status:", excludeStatus);

        if (excludeStatus) {
          const excludeStatusString = String(excludeStatus);
          const statusesToExclude = excludeStatusString.split(",");
          statusesToExclude.forEach((s: string) => {
            customersQuery = customersQuery.neq("status", s.trim());
          });
        }

        // Apply date filters if provided
        if (dateFrom || dateTo) {
          if (dateFrom) {
            customersQuery = customersQuery.gte("created_at", dateFrom);
          }
          if (dateTo) {
            customersQuery = customersQuery.lte("created_at", dateTo);
          }
        }

        // Get total count first
        const { count: totalCount } = await customersQuery;

        // Now get paginated results
        const { data: customers, error: custErr } = await customersQuery
          .order("scheduled_time", { ascending: true })
          .range(offset, offset + limitNum - 1);

        if (custErr) throw custErr;

        // Fetch all jobs and time tracking data
        const { data: jobs, error: jobsErr } = await supabase
          .from("jobs")
          .select("*");
        if (jobsErr) throw jobsErr;

        const { data: timeTracking, error: timeErr } = await supabase
          .from("time_tracking")
          .select("job_id, end_time");
        if (timeErr) console.error("Error fetching time tracking:", timeErr);

        // Map customers to jobs
        const jobsWithCustomers = customers.map((c) => {
          const assigned = jobs?.find((j) => j.customer_id === c.id);
          const timeEntry = timeTracking?.find(
            (t) => t.job_id === assigned?.id
          );
          return {
            ...c,
            created_at: assigned?.created_at || c.created_at,
            job_id: assigned?.id || null,
            job_status: assigned?.job_status || "new",
            completion_time: timeEntry?.end_time || null,
            engineer_uuid: assigned?.engineer_uuid || null,
            engineer_name: assigned?.engineer_name || null,
          };
        });

        // Filter by engineer if specified
        const result = engineer_id
          ? jobsWithCustomers.filter((j) => j.engineer_uuid === engineer_id)
          : jobsWithCustomers;

        // Calculate pagination metadata
        const totalPages = Math.ceil((totalCount || 0) / limitNum);

        console.log(
          `Fetched ${result.length} jobs (Page ${pageNum} of ${totalPages})`
        );
        res.json({
          data: result,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalCount || 0,
            totalPages,
            hasNextPage: pageNum < totalPages,
            hasPreviousPage: pageNum > 1,
          },
        });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch jobs" });
      }
    }
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
    }
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
    }
  );

  /* ===========================
     CALCULATE DISTANCE BETWEEN TWO COORDINATES (HAVERSINE FORMULA)
  ============================*/
  function calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
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

        const startTime = `${startHour.toString().padStart(2, "0")}:${startMin
          .toString()
          .padStart(2, "0")}`;
        const endTime = `${endHour.toString().padStart(2, "0")}:${endMin
          .toString()
          .padStart(2, "0")}`;

        return currentTime >= startTime && currentTime <= endTime;
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
    lon2: number
  ): Promise<number | null> {
    const apiKey = process.env.GOOGLE_API_KEY; // Store it in .env
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat1},${lon1}&destinations=${lat2},${lon2}&key=${apiKey}`;

    try {
      const response = await axios.get(url);

      if (
        !response.data ||
        !response.data.rows ||
        response.data.rows.length === 0
      ) {
        console.error("Google API returned invalid data structure");
        return null;
      }

      const element = response.data.rows[0].elements[0];

      if (
        element.status === "OK" &&
        element.distance &&
        element.distance.value !== undefined
      ) {
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
  /* ===========================
     GET ACTIVE JOB - Check pause state and calculate current time
  ============================*/
  app.get("/api/engineers/:engineerId/active-job", async (req, res) => {
    try {
      const { engineerId } = req.params;

      // Find active time tracking entry with new columns
      const { data: activeEntry, error } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("engineer_id", engineerId)
        .is("end_time", null)
        .order("start_time", { ascending: false })
        .limit(1)
        .single();

      console.log("error in the error", error);
      if (error) {
        if (error.code === "PGRST116") {
          console.log(
            `No active time tracking found for engineer ${engineerId}`
          );
          return res
            .status(404)
            .json({ message: "No active Timer start found in the job" });
        }
        console.error(`❌ Database error fetching time tracking:`, error);
        return res.status(500).json({ error: "Database error" });
      }

      if (!activeEntry) {
        console.log(`No active entry found for engineer ${engineerId}`);
        return res.status(404).json({ message: "No active job found" });
      }

      // Get job details
      const { data: jobData, error: jobStatusError } = await supabase
        .from("jobs")
        .select("job_status, image_urls")
        .eq("id", activeEntry.job_id)
        .single();

      if (jobStatusError) {
        if (jobStatusError.code === "PGRST116") {
          console.log(`Job ${activeEntry.job_id} not found`);
          return res.status(404).json({ message: "No active job found" });
        }
        console.error(`❌ Database error fetching job:`, jobStatusError);
        return res.status(500).json({ error: "Database error" });
      }

      const jobStatus = jobData?.job_status?.toLowerCase() || "";
      console.log(
        `Job ${activeEntry.job_id} status: ${jobStatus}, is_paused: ${activeEntry.is_paused}`
      );

      // ✅ IMPORTANT FIX: Return the data even for quoted/approved jobs
      // The timer is just paused, not ended, so we need this data

      // Calculate current total time
      let currentTotalMinutes = activeEntry.accumulated_minutes || 0;
      if (!activeEntry.is_paused) {
        const lastActionTime =
          activeEntry.pause_start_time || activeEntry.start_time;
        const currentSegment = Math.floor(
          (Date.now() - new Date(lastActionTime).getTime()) / 1000 / 60
        );
        currentTotalMinutes += currentSegment;
      }

      // ✅ ALWAYS return the timer data if it exists (even for quoted/approved)
      res.json({
        job_id: activeEntry.job_id,
        start_time: activeEntry.start_time,
        engineer_id: activeEntry.engineer_id,
        accumulated_minutes: activeEntry.accumulated_minutes,
        is_paused: activeEntry.is_paused,
        pause_start_time: activeEntry.pause_start_time,
        current_total_minutes: currentTotalMinutes,
        job_status: jobData.job_status,
        image_urls: jobData.image_urls,
      });
    } catch (err) {
      console.error("❌ Unexpected error in /active-job endpoint:", err);
      return res.status(500).json({ error: "Failed to fetch active job" });
    }
  });

  /* ===========================
     START JOB TIMER WITH LOCATION & TIME VERIFICATION
  ============================*/
  /* ===========================
     START JOB - Create single time tracking row with new columns
  ============================*/
  app.post("/api/start-job", async (req, res) => {
    try {
      const { job_id, engineer_id, engineer_latitude, engineer_longitude } =
        req.body;

      if (!job_id || !engineer_id) {
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });
      }

      // Check if time tracking already exists for this job
      const { data: existingEntry } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .single();

      if (existingEntry) {
        // If paused, resume it
        if (existingEntry.is_paused) {
          const resumeTime = new Date().toISOString();
          await supabase
            .from("time_tracking")
            .update({
              is_paused: false,
              pause_start_time: resumeTime,
            })
            .eq("id", existingEntry.id);

          return res.json({
            success: true,
            message: "Job resumed",
            time_entry: existingEntry,
          });
        }
        return res.status(400).json({
          error: "Time tracking already active for this job",
        });
      }

      // Get job details for validation
      const { data: jobData } = await supabase
        .from("jobs")
        .select(
          "customer_id, customer_latitude, customer_longitude, site_location, job_status"
        )
        .eq("id", job_id)
        .single();

      if (!jobData) {
        return res.status(404).json({ error: "Job not found" });
      }

      if (jobData.job_status?.toLowerCase() === "quoted") {
        return res.status(403).json({
          error:
            "Cannot start job with Quoted status. Please wait for admin approval.",
        });
      }

      // Get customer details
      const { data: customerData } = await supabase
        .from("customers")
        .select("Opening_Hours")
        .eq("id", jobData.customer_id)
        .single();

      if (!customerData) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const locationData = {
        latitude: jobData.customer_latitude,
        longitude: jobData.customer_longitude,
        Site_Location: jobData.site_location,
        Opening_Hours: customerData.Opening_Hours,
      };

      // Location verification
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

      // Distance calculation (keeping your existing logic)
      let distance = null;
      const latDiff = Math.abs(
        engineer_latitude - Number(locationData.latitude)
      );
      const lonDiff = Math.abs(
        engineer_longitude - Number(locationData.longitude)
      );

      if (latDiff < 0.0001 && lonDiff < 0.0001) {
        distance = 0;
      } else {
        distance = await getDrivingDistance(
          engineer_latitude,
          engineer_longitude,
          Number(locationData.latitude),
          Number(locationData.longitude)
        );

        if (distance === null) {
          distance = calculateDistance(
            engineer_latitude,
            engineer_longitude,
            Number(locationData.latitude),
            Number(locationData.longitude)
          );
        }
      }

      if (distance === null) {
        return res.status(400).json({
          error: "Distance check failed",
          message: "⚠️ Unable to verify distance. Please try again.",
        });
      }

      if (distance > 800000000) {
        return res.status(400).json({
          error: "Location verification failed",
          message: `⚠️ You must be within 1km of the job site to start. You're currently ${(
            distance / 1000
          ).toFixed(2)}km away.`,
          distance: Math.round(distance),
          distanceKm: (distance / 1000).toFixed(2),
        });
      }

      // Time verification
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

      // Create single time tracking row with NEW COLUMNS
      const { data, error } = await supabase
        .from("time_tracking")
        .insert({
          job_id,
          engineer_id,
          start_time: startTime,
          accumulated_minutes: 0, // NEW COLUMN
          is_paused: false, // NEW COLUMN
          pause_start_time: startTime, // NEW COLUMN
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
  /* ===========================
     PAUSE JOB - Actually pause and accumulate time
  ============================*/
  app.post("/api/pause-job", async (req, res) => {
    try {
      const { job_id, engineer_id } = req.body;

      if (!job_id || !engineer_id) {
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });
      }

      // Get the single row
      const { data: entry } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .single();

      if (!entry) {
        return res.status(404).json({ error: "No active time entry found" });
      }

      if (entry.is_paused) {
        return res.status(400).json({
          error: "Job is already paused",
          accumulated_minutes: entry.accumulated_minutes,
        });
      }

      // Calculate time since last action (start or resume)
      const lastActionTime = entry.pause_start_time || entry.start_time;
      const minutesSinceLastAction = Math.floor(
        (Date.now() - new Date(lastActionTime).getTime()) / 1000 / 60
      );

      const newAccumulatedMinutes =
        (entry.accumulated_minutes || 0) + minutesSinceLastAction;
      const pauseTime = new Date().toISOString();

      // Update the SAME row
      const { error: updateError } = await supabase
        .from("time_tracking")
        .update({
          accumulated_minutes: newAccumulatedMinutes,
          is_paused: true,
          pause_start_time: pauseTime,
        })
        .eq("id", entry.id);

      if (updateError) throw updateError;

      res.json({
        success: true,
        paused_at: pauseTime,
        session_minutes: minutesSinceLastAction,
        total_minutes: newAccumulatedMinutes,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to pause job" });
    }
  });
  /* ===========================
     RESUME JOB TIMER (Frontend-only tracking)
  ============================*/
  /* ===========================
     RESUME JOB - Mark as not paused and update pause_start_time
  ============================*/
  app.post("/api/resume-job", async (req, res) => {
    try {
      const { job_id, engineer_id } = req.body;

      if (!job_id || !engineer_id) {
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });
      }

      // Get the single row
      const { data: entry } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .single();

      if (!entry) {
        return res.status(404).json({ error: "No active time entry found" });
      }

      if (!entry.is_paused) {
        return res.status(400).json({
          error: "Job is not paused",
          accumulated_minutes: entry.accumulated_minutes,
        });
      }

      const resumeTime = new Date().toISOString();

      // Update the SAME row - just mark as resumed
      const { error: updateError } = await supabase
        .from("time_tracking")
        .update({
          is_paused: false,
          pause_start_time: resumeTime, // Track when we resumed for next calculation
        })
        .eq("id", entry.id);

      if (updateError) throw updateError;

      const { data: jobData } = await supabase
        .from("jobs")
        .select("job_status")
        .eq("id", job_id)
        .single();

      // ✅ If status was "Approved", change it to "Working" to indicate post-quote work
      if (jobData?.job_status?.toLowerCase() === "approved") {
        await supabase
          .from("jobs")
          .update({ job_status: "Working" }) // New status!
          .eq("id", job_id);
      }

      res.json({
        success: true,
        resumed_at: resumeTime,
        accumulated_minutes: entry.accumulated_minutes,
        job_status:
          jobData?.job_status === "Approved" ? "Working" : jobData?.job_status,
      });
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
        customerData.longitude
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
  /* ===========================
     END JOB - Calculate final time with accumulated + current segment
  ============================*/
  app.post("/api/end-job", async (req, res) => {
    try {
      const {
        job_id,
        engineer_id,
        image_data,
        products = [],
        manual_duration_minutes = null,
        time_adjustment_minutes = 0,
        adjustment_reason = "",
      } = req.body;

      if (!job_id || !engineer_id) {
        return res
          .status(400)
          .json({ error: "job_id and engineer_id required" });
      }

      // Get the single time tracking row
      const { data: entry } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .single();

      if (!entry) {
        return res.status(404).json({ error: "No active time entry found" });
      }

      const endTime = new Date().toISOString();
      let totalDurationMinutes;
      let calculationMethod;
      let finalAdjustmentReason = "";
      let finalAdjustmentMinutes = 0;

      if (manual_duration_minutes !== null && manual_duration_minutes >= 0) {
        // Manual override
        totalDurationMinutes = manual_duration_minutes;
        calculationMethod = "manual_override";
        finalAdjustmentReason =
          adjustment_reason || "Manual time entry by engineer";
      } else {
        // Calculate from accumulated + current segment if not paused
        let finalMinutes = entry.accumulated_minutes || 0;

        if (!entry.is_paused) {
          // Add time since last resume/start
          const lastActionTime = entry.pause_start_time || entry.start_time;
          const currentSegment = Math.floor(
            (Date.now() - new Date(lastActionTime).getTime()) / 1000 / 60
          );
          finalMinutes += currentSegment;
        }

        // Apply adjustment
        if (time_adjustment_minutes !== 0) {
          totalDurationMinutes = Math.max(
            0,
            finalMinutes + time_adjustment_minutes
          );
          calculationMethod = "adjusted";
          finalAdjustmentReason =
            adjustment_reason ||
            `Time adjusted by ${time_adjustment_minutes} minutes`;
          finalAdjustmentMinutes = time_adjustment_minutes;
        } else {
          totalDurationMinutes = finalMinutes;
          calculationMethod = "automatic";
        }
      }

      // Update the time tracking row with final data INCLUDING calculation method and reason
      await supabase
        .from("time_tracking")
        .update({
          end_time: endTime,
          duration_minutes: totalDurationMinutes,
          is_paused: false,
          accumulated_minutes: totalDurationMinutes,
          calculation_method: calculationMethod,
          adjustment_reason: finalAdjustmentReason,
          adjustment_minutes: finalAdjustmentMinutes,
        })
        .eq("id", entry.id);

      // Handle image (already HTTPS URL)
      const imageUrl = image_data || null;

      // Update job status
      await supabase
        .from("jobs")
        .update({
          job_status: "Completed",
        })
        .eq("id", job_id);

      // Update customer status
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

      // Send webhook with total time and calculation method
      try {
        await fetch("https://keptcoldhvac.app.n8n.cloud/webhook/end-job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            job_id,
            engineer_id,
            duration_minutes: totalDurationMinutes,
            calculation_method: calculationMethod,
            adjustment_reason: finalAdjustmentReason,
            end_time: endTime,
            image_url: imageUrl,
            products_used: products,
          }),
        });
      } catch (webhookErr) {
        console.error("Webhook error:", webhookErr);
      }

      res.json({
        success: true,
        total_duration_minutes: totalDurationMinutes,
        calculation_method: calculationMethod,
        image_url: imageUrl,
        products_count: products.length,
      });
    } catch (err) {
      console.error("❌ Error in end-job:", err);
      res.status(500).json({ error: "Failed to end job" });
    }
  });

  /* ===========================
     UPLOAD MULTIPLE IMAGES TO IMAGEKIT
  ============================*/
  app.post(
    "/api/upload-images-imagekit",
    upload.array("images", 10),
    async (req, res) => {
      try {
        const files = req.files as Express.Multer.File[];
        const job_id = req.body.job_id;

        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No images provided" });
        }

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
        }

        res.json({ success: true, urls: uploadedUrls });
      } catch (err) {
        console.error("ImageKit upload error:", err);
        res.status(500).json({ error: "Failed to upload images" });
      }
    }
  );

  /* ===========================
     SUBMIT JOB QUOTE WITH IMAGES, PRODUCTS, NOTES
  ============================*/
  /* ===========================
     SUBMIT JOB QUOTE - Pause the job (don't end it)
  ============================*/
  app.post("/api/submit-job-quote", async (req, res) => {
    try {
      const { job_id, image_urls, product_names, notes, engineer_id } =
        req.body;

      if (!job_id) {
        return res.status(400).json({ error: "Job ID is required" });
      }

      // Check current status
      const { data: existingJob } = await supabase
        .from("jobs")
        .select("job_status")
        .eq("id", job_id)
        .single();

      const currentStatus = existingJob?.job_status?.toLowerCase() || "";
      if (currentStatus === "quoted" || currentStatus === "approved") {
        return res.status(400).json({
          error: "Quote already submitted",
          message: `This job already has status "${existingJob?.job_status}".`,
        });
      }

      // PAUSE the time tracking (don't end it!)
      const { data: timeEntry } = await supabase
        .from("time_tracking")
        .select("*")
        .eq("job_id", job_id)
        .eq("engineer_id", engineer_id)
        .is("end_time", null)
        .single();

      let pausedMinutes = 0;
      if (timeEntry && !timeEntry.is_paused) {
        // Calculate and accumulate current segment
        const lastActionTime =
          timeEntry.pause_start_time || timeEntry.start_time;
        const currentSegment = Math.floor(
          (Date.now() - new Date(lastActionTime).getTime()) / 1000 / 60
        );

        pausedMinutes = (timeEntry.accumulated_minutes || 0) + currentSegment;
        const pauseTime = new Date().toISOString();

        // Pause the timer (keep row active for later resume)
        await supabase
          .from("time_tracking")
          .update({
            accumulated_minutes: pausedMinutes,
            is_paused: true,
            pause_start_time: pauseTime,
          })
          .eq("id", timeEntry.id);
      } else if (timeEntry && timeEntry.is_paused) {
        pausedMinutes = timeEntry.accumulated_minutes || 0;
      }

      // Update job status to Quoted
      const { data: updatedJob, error: updateError } = await supabase
        .from("jobs")
        .update({
          job_status: "Quoted",
          image_urls: image_urls || [],
          product_names: product_names || [],
          notes: notes || "",
        })
        .eq("id", job_id)
        .eq("job_status", "In Progress")
        .select()
        .single();

      if (updateError) {
        // If update failed, resume timer if we paused it
        if (timeEntry && !timeEntry.is_paused) {
          await supabase
            .from("time_tracking")
            .update({
              accumulated_minutes: timeEntry.accumulated_minutes,
              is_paused: false,
              pause_start_time: timeEntry.pause_start_time,
            })
            .eq("id", timeEntry.id);
        }
        throw new Error(`Failed to update job status: ${updateError.message}`);
      }

      if (!updatedJob) {
        return res.status(409).json({
          error: "Quote already submitted",
          message: "This job is not in 'In Progress' status.",
        });
      }

      // Trigger webhook
      try {
        await fetch(
          "https://keptcoldhvac.app.n8n.cloud/webhook/job-quote-webhook",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              job_id,
              engineer_id,
              image_urls,
              product_names,
              notes,
              status: "Quote",
              time_paused_at_minutes: pausedMinutes,
              timestamp: new Date().toISOString(),
            }),
          }
        );
      } catch (webhookErr) {
        console.error("Webhook error:", webhookErr);
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
  app.get(
    "/api/leads-summary",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        // Total customers
        const { count: totalCustomers, error: customerError } = await supabase
          .from("companies")
          .select("*", { count: "exact", head: true }); // only count, no data

        if (customerError) {
          console.error(
            "Error fetching customer count:",
            customerError.message
          );
          return res.status(500).json({ error: customerError.message });
        }

        // Total pending leads
        const { count: pendingLeads, error: pendingError } = await supabase
          .from("companies")
          .select("*", { count: "exact", head: true })
          .eq("status", "Pending");

        if (pendingError) {
          console.error(
            "Error fetching pending leads count:",
            pendingError.message
          );
          return res.status(500).json({ error: pendingError.message });
        }

        res.json({
          totalCustomers: totalCustomers || 0,
          pendingLeads: pendingLeads || 0,
        });
      } catch (err) {
        console.error("Unexpected error in /api/leads-summary:", err);
        res.status(500).json({ error: "Failed to fetch leads summary" });
      }
    }
  );

  /* ===========================
     INVOICES MANAGEMENT - ADMIN ONLY
  ============================*/
  app.get("/api/invoices", requireAdminAuth, async (req: AdminRequest, res) => {
    try {
      const { page = "1", limit = "10", search = "", status = "" } = req.query;

      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const offset = (pageNum - 1) * limitNum;

      // Build the base query
      let invoicesQuery = supabase
        .from("Invoice")
        .select("*", { count: "exact" });

      // Apply search filter if provided
      if (search) {
        invoicesQuery = invoicesQuery.or(
          `id.eq.${isNaN(Number(search)) ? 0 : search},job_id.eq.${isNaN(Number(search)) ? 0 : search
          },customer_id.eq.${isNaN(Number(search)) ? 0 : search}`
        );
      }

      // Apply status filter if provided
      if (status && status !== "all") {
        invoicesQuery = invoicesQuery.eq("status", status);
      }

      // Get total count first
      const { count: totalCount } = await invoicesQuery;

      // Now get paginated results, sorted by newest first
      const { data, error } = await invoicesQuery
        .order("created_at", { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (error) {
        console.error("Error fetching invoices:", error.message);
        return res.status(500).json({ error: error.message });
      }

      // Calculate pagination metadata
      const totalPages = Math.ceil((totalCount || 0) / limitNum);

      res.json({
        data: data || [],
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount || 0,
          totalPages,
          hasNextPage: pageNum < totalPages,
          hasPreviousPage: pageNum > 1,
        },
      });
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
      const {
        page = "1",
        limit = "10",
        search = "",
        status = "",
        pricingStatus = "",
      } = req.query;

      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const offset = (pageNum - 1) * limitNum;

      // Build the base query
      let quotesQuery = supabase.from("quotes").select("*", { count: "exact" });

      // Enhanced search - now can search by business name, engineer name, contact, location
      if (search) {
        quotesQuery = quotesQuery.or(
          `id.eq.${isNaN(Number(search)) ? 0 : search},` +
          `job_id.eq.${isNaN(Number(search)) ? 0 : search},` +
          `business_name.ilike.%${search}%,` +
          `eng_name.ilike.%${search}%,` +
          `site_contact_name.ilike.%${search}%,` +
          `site_location.ilike.%${search}%`
        );
      }

      // Apply status filter if provided
      if (status && status !== "all") {
        quotesQuery = quotesQuery.eq("status", status);
      }

      // Apply pricing status filter if provided
      if (pricingStatus) {
        if (pricingStatus === "priced") {
          quotesQuery = quotesQuery.not("p_prices", "is", null);
        } else if (pricingStatus === "pending") {
          quotesQuery = quotesQuery.is("p_prices", null);
        }
      }

      // Get total count first
      const { count: totalCount } = await quotesQuery;

      // Now get paginated results, sorted by newest first
      const { data, error } = await quotesQuery
        .order("id", { ascending: false })
        .range(offset, offset + limitNum - 1);

      if (error) {
        console.error("Supabase error fetching quotes:", error);
        return res.status(500).json({
          success: false,
          error: "Failed to fetch quotes",
          details: error.message,
        });
      }

      // Transform data to add calculated fields
      const transformedData = (data || []).map((quote) => {
        // Calculate total price if p_prices exists
        let totalPrice = null;
        if (quote.p_prices) {
          const visitFee = parseFloat(quote.p_prices.visit_fee || "0");
          const productsTotal = (quote.p_prices.product_prices || []).reduce(
            (sum: number, item: any) => sum + parseFloat(item.price || "0"),
            0
          );
          totalPrice = visitFee + productsTotal;
        }

        return {
          ...quote,
          total_price: totalPrice,
          products_count: quote.products?.length || 0,
          has_pricing: quote.p_prices !== null,
        };
      });

      // Calculate pagination metadata
      const totalPages = Math.ceil((totalCount || 0) / limitNum);

      return res.json({
        success: true,
        data: transformedData,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount || 0,
          totalPages,
          hasNextPage: pageNum < totalPages,
          hasPreviousPage: pageNum > 1,
        },
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
              webhookResponse.statusText
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
    }
  );

  /* ===========================
     GET UNSCHEDULED JOBS (CUSTOMERS WITH STATUS='NEW') - ADMIN ONLY
  ============================*/
  app.get(
    "/api/customers/unscheduled",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { date, priority } = req.query;

        let query = supabase
          .from("customers")
          .select("*")
          .eq("status", "new")
          .order("Priority", { ascending: true })
          .order("scheduled_time", { ascending: true });


        console.log('quert ib the server ', query)
        // Filter by date if provided
        if (date) {
          const startOfDay = new Date(date as string);
          startOfDay.setHours(0, 0, 0, 0);
          const endOfDay = new Date(date as string);
          endOfDay.setHours(23, 59, 59, 999);

          query = query
            .gte("scheduled_time", startOfDay.toISOString())
            .lte("scheduled_time", endOfDay.toISOString());
        }

        // Filter by priority if provided
        if (priority) {
          query = query.eq("Priority", priority);
        }

        const { data: customers, error } = await query;


        if (error) {
          console.error("Error fetching unscheduled jobs:", error);
          return res.status(400).json({ error: error.message });
        }

        // Transform to Job format
        const jobs = (customers || []).map((customer) => ({
          id: customer.id.toString(),
          reference: `JOB-${customer.id}`,
          clientName: customer.Business_Name,
          address: customer.Site_Location,
          latitude: customer.latitude,
          longitude: customer.longitude,
          duration: 120, // Default 2 hours, can be customized
          priority: customer.Priority?.toLowerCase() || "normal",
          postCode: customer.Post_Code,
          openingHours: customer.Opening_Hours,
          description: customer.Description_of_Fault,
          scheduledTime: customer.scheduled_time,
        }));

        console.log(`✅ Fetched ${jobs.length} unscheduled jobs`);
        res.json({ jobs });
      } catch (err) {
        console.error("Error in /api/customers/unscheduled:", err);
        res.status(500).json({ error: "Failed to fetch unscheduled jobs" });
      }
    }
  );

  /* ===========================
     GET ACTIVE ENGINEERS - ADMIN ONLY
  ============================*/
  app.get(
    "/api/engineers/active",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { data: engineers, error } = await supabase
          .from("engineers")
          .select("*")
          .order("eng_name", { ascending: true });

        if (error) {
          console.error("Error fetching engineers:", error);
          return res.status(400).json({ error: error.message });
        }

        console.log(`✅ Fetched ${engineers?.length || 0} engineers`);
        res.json({ engineers: engineers || [] });
      } catch (err) {
        console.error("Error in /api/engineers/active:", err);
        res.status(500).json({ error: "Failed to fetch engineers" });
      }
    }
  );

  /* ===========================
     OPTIMIZE ROUTE USING GOOGLE MAPS DIRECTIONS API - ADMIN ONLY
  ============================*/
  app.post(
    "/api/routes/optimize",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const {
          engineer_id,
          job_ids,
          consider_traffic = true,
        } = req.body;

        if (!engineer_id || !job_ids || job_ids.length === 0) {
          return res.status(400).json({
            error: "engineer_id and job_ids are required",
          });
        }

        // Fetch engineer location
        const { data: engineer, error: engineerError } = await supabase
          .from("engineers")
          .select("latitude, longitude, eng_name")
          .eq("id", engineer_id)
          .single();

        if (engineerError || !engineer) {
          return res.status(404).json({ error: "Engineer not found" });
        }

        if (!engineer.latitude || !engineer.longitude) {
          return res.status(400).json({
            error:
              "Engineer location not available. Please update engineer's GPS location.",
          });
        }

        // Fetch job locations
        const { data: customers, error: customersError } = await supabase
          .from("customers")
          .select("*")
          .in("id", job_ids.map(Number));

        if (customersError || !customers || customers.length === 0) {
          return res.status(404).json({ error: "Jobs not found" });
        }

        // Filter jobs with valid coordinates
        const validJobs = customers.filter((c) => c.latitude && c.longitude);

        if (validJobs.length === 0) {
          return res.status(400).json({
            error:
              "No jobs have valid coordinates. Please geocode addresses first.",
          });
        }

        // IMPORTANT: Maintain the order from job_ids array
        const orderedJobs = [];
        for (const jobId of job_ids) {
          const job = validJobs.find(j => parseInt(j.id) === jobId);
          if (job) {
            orderedJobs.push(job);
          }
        }

        console.log(
          `🚀 Calculating route for ${engineer.eng_name} with ${orderedJobs.length} jobs`
        );

        // Build waypoints for Google Directions API
        const waypoints = orderedJobs
          .map((job) => `${job.latitude},${job.longitude}`)
          .join("|");

        const origin = `${engineer.latitude},${engineer.longitude}`;
        const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;

        // CRITICAL CHANGE: Use LAST job as destination, not origin (no round trip!)
        const lastJob = orderedJobs[orderedJobs.length - 1];
        const destination = `${lastJob.latitude},${lastJob.longitude}`;

        // For single job, use it as both waypoint and destination
        let url;
        if (orderedJobs.length === 1) {
          // Single job - direct route from engineer to job
          url =
            `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${origin}&` +
            `destination=${destination}&` +
            `mode=driving&` +
            `departure_time=${consider_traffic ? "now" : ""}&` +
            `traffic_model=${consider_traffic ? "best_guess" : ""}&` +
            `key=${apiKey}`;
        } else {
          // Multiple jobs - route through waypoints to last job
          const intermediateWaypoints = orderedJobs
            .slice(0, -1) // All except last job
            .map((job) => `${job.latitude},${job.longitude}`)
            .join("|");

          url =
            `https://maps.googleapis.com/maps/api/directions/json?` +
            `origin=${origin}&` +
            `destination=${destination}&` +
            `waypoints=${intermediateWaypoints}&` + // Waypoints (excluding last job)
            `mode=driving&` +
            `departure_time=${consider_traffic ? "now" : ""}&` +
            `traffic_model=${consider_traffic ? "best_guess" : ""}&` +
            `key=${apiKey}`;
        }

        const googleResponse = await fetch(url);
        const googleData = (await googleResponse.json()) as any;

        if (googleData.status !== "OK") {
          console.error("Google Maps API error:", googleData);
          return res.status(400).json({
            error: `Route calculation failed: ${googleData.status}`,
            details: googleData.error_message,
          });
        }

        const route = googleData.routes[0];
        const legs = route.legs;

        // Calculate distances only (no time estimates)
        const optimizedJobs = orderedJobs.map((job, index) => {
          const leg = legs[index];
          const travelTime = Math.ceil((leg.duration?.value || 0) / 60);
          const distance = leg.distance?.value || 0;

          return {
            id: job.id.toString(),
            reference: `JOB-${job.id}`,
            clientName: job.Business_Name,
            address: job.Site_Location,
            latitude: job.latitude,
            longitude: job.longitude,
            duration: 120, // 2 hours per job
            priority: job.Priority?.toLowerCase() || "normal",
            arrivalTime: "--:--", // Not calculating times
            departureTime: "--:--", // Not calculating times
            order: index + 1,
            travelTimeFromPrevious: travelTime,
            distanceFromPrevious: distance,
          };
        });

        // Calculate total distance only
        const totalDistance = legs.reduce(
          (sum: number, leg: any) => sum + (leg.distance?.value || 0),
          0
        );

        console.log(
          `✅ Route calculated: ${optimizedJobs.length} stops, ${(
            totalDistance / 1000
          ).toFixed(1)}km total`
        );

        res.json({
          optimizedJobs,
          totalDistance,
          totalTime: 0, // Not calculating
          estimatedFinish: "--:--", // Not calculating
          polyline: route.overview_polyline?.points,
        });
      } catch (err) {
        console.error("Error in /api/routes/optimize:", err);
        res.status(500).json({ error: "Route calculation failed" });
      }
    }
  );

  /* ===========================
     ASSIGN OPTIMIZED ROUTE TO ENGINEER - ADMIN ONLY
  ============================*/
  app.post("/api/routes/assign", requireAdminAuth, async (req, res) => {
    try {
      const { engineer_id, date, jobs, total_distance, polyLine } = req.body;

      console.log('=== DEBUG: Full request body ===');
      console.log('engineer_id:', engineer_id);
      console.log('date:', date);
      console.log('total_distance:', total_distance);
      console.log('has_polyline:', !!polyLine);
      console.log('jobs array:', JSON.stringify(jobs, null, 2));
      console.log('===============================');


      // 1. VALIDATE
      if (!engineer_id || !jobs || jobs.length === 0) {
        return res.status(400).json({ error: "Engineer and jobs are required" });
      }

      // 2. CHECK ENGINEER
      const { data: engineer } = await supabase
        .from("engineers")
        .select("eng_name")
        .eq("id", engineer_id)
        .single();

      if (!engineer) {
        return res.status(404).json({ error: "Engineer not found" });
      }

      console.log('Engineer:', engineer.eng_name);

      // 3. CREATE ROUTE
      const { data: route, error: routeError } = await supabase
        .from("routes")
        .insert({
          engineer_id,
          date,
          jobs, // Store jobs as JSON
          total_distance,
          polyline: polyLine,
          status: 'scheduled'
        })
        .select()
        .single();

      if (routeError) {
        console.error("Route creation error:", routeError);
        return res.status(500).json({ error: "Failed to create route" });
      }

      console.log('✅ Route created:', route.id);

      // 4. CREATE JOBS - USING EXACT COLUMN NAMES FROM YOUR TABLE
      const assignedJobs = [];
      const errors = [];

      for (const routeJob of jobs) {
        try {
          const customerId = parseInt(routeJob.customer_id);
          console.log(`Processing customer ID: ${customerId}`);

          // Fetch customer
          const { data: customer } = await supabase
            .from("customers")
            .select("*")
            .eq("id", customerId)
            .single();

          if (!customer) {
            console.log(`❌ Customer not found: ${customerId}`);
            errors.push({
              customer_id: customerId,
              error: "Customer not found"
            });
            continue;
          }

          console.log(`✅ Found customer: ${customer.Business_Name}`);

          // Create scheduled time
          const scheduledDateTime = new Date(date);
          scheduledDateTime.setHours(8, 0, 0, 0);

          // CREATE JOB RECORD - EXACT COLUMN NAMES FROM YOUR TABLE
          const { data: newJob, error: jobError } = await supabase
            .from("jobs")
            .insert({
              customer_id: customerId,
              engineer_uuid: engineer_id,
              engineer_name: engineer.eng_name,
              description: customer.Description_of_Fault || "Assigned job",
              site_location: customer.Site_Location,
              customer_latitude: customer.latitude || 0,
              customer_longitude: customer.longitude || 0,
              site_contact_naame: customer.Site_Contact_Name, // ← EXACT NAME
              site_contact_number: customer.Site_Contact_Number,
              open_time: customer.Opening_Hours || "N/A",
              business_name: customer.Business_Name,
              System_Details: customer.System_Details || "N/A",
              schedule_time: scheduledDateTime.toISOString(),
              job_status: "Assigned",
              route_id: route.id,
              route_order: routeJob.order || 0
              // Note: Not including invoice_url, job_desc, product_names, image_urls, notes
              // as they might not be required for initial job creation
            })
            .select()
            .single();

          if (jobError) {
            console.error(`❌ Job creation error for customer ${customerId}:`, jobError);
            errors.push({
              customer_id: customerId,
              error: jobError.message
            });
            continue;
          }

          console.log(`✅ Job created: ${newJob.id}`);

          // Update customer status
          const { error: customerUpdateError } = await supabase
            .from("customers")
            .update({
              status: "assigned",
              assigned_engineer: engineer_id,
              scheduled_time: scheduledDateTime.toISOString(),
            })
            .eq("id", customerId);

          if (customerUpdateError) {
            console.error(`⚠️ Failed to update customer ${customerId}:`, customerUpdateError);
          } else {
            console.log(`✅ Customer ${customerId} updated to assigned`);
          }

          assignedJobs.push(newJob);

        } catch (err) {
          console.error(`❌ Error processing job ${routeJob.customer_id}:`, err);
          errors.push({
            customer_id: routeJob.customer_id,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      // 5. RETURN RESPONSE
      console.log(`✅ Route assignment complete: ${assignedJobs.length} jobs created`);

      res.json({
        success: true,
        route_id: route.id,
        jobs_assigned: assignedJobs.length,
        assigned_jobs: assignedJobs,
        errors: errors.length > 0 ? errors : undefined,
        message: `${assignedJobs.length} jobs assigned to ${engineer.eng_name}`
      });

    } catch (err) {
      console.error("❌ Error in /api/routes/assign:", err);
      res.status(500).json({
        error: "Route assignment failed",
        details: err instanceof Error ? err.message : "Unknown error"
      });
    }
  });


  app.get("/api/routes", requireAdminAuth, async (req: AdminRequest, res) => {
    try {
      const { date } = req.query;

      let query = supabase
        .from("routes")
        .select(`
        *,
        engineer:engineers (
          eng_name,
          area,
          speciality
        )
      `)
        .order("date", { ascending: true });

      // Filter by date if provided
      if (date) {
        query = query.eq("date", date);
      }

      const { data: routes, error } = await query;

      if (error) {
        console.error("Error fetching routes:", error);
        return res.status(500).json({ error: "Failed to fetch routes" });
      }

      res.json({ routes });

    } catch (err) {
      console.error("Error in /api/routes:", err);
      res.status(500).json({ error: "Failed to fetch routes" });
    }
  });


  // Add to backend
  // Update this endpoint in your index.ts
  app.get("/api/routes/:id", requireAdminAuth, async (req: AdminRequest, res) => {
    try {
      const { id } = req.params;

      console.log('🚀 Fetching route details for ID:', id);

      // 1. Get the route
      const { data: route, error: routeError } = await supabase
        .from("routes")
        .select("*")
        .eq("id", id)
        .single();

      if (routeError || !route) {
        console.error("❌ Route not found:", routeError);
        return res.status(404).json({ error: "Route not found" });
      }

      console.log('✅ Route found:', route.id, 'for engineer:', route.engineer_id);

      // 2. Get engineer details
      const { data: engineer, error: engineerError } = await supabase
        .from("engineers")
        .select("id, eng_name, area, speciality, work_start_time, work_end_time, latitude, longitude")
        .eq("id", route.engineer_id)
        .single();

      if (engineerError) {
        console.error("⚠️ Engineer fetch error:", engineerError);
      }

      console.log('✅ Engineer found:', engineer?.eng_name);

      // 3. Get jobs for this route
      const { data: jobs, error: jobsError } = await supabase
        .from("jobs")
        .select("*")
        .eq("route_id", id)
        .order("route_order", { ascending: true });

      if (jobsError) {
        console.error("⚠️ Jobs fetch error:", jobsError);
      }

      console.log(`✅ Found ${jobs?.length || 0} jobs for route`);

      // 4. Return everything
      res.json({
        route: {
          ...route,
          engineer: engineer || null
        },
        jobs: jobs || []
      });

    } catch (err) {
      console.error("🔥 Error in /api/routes/:id:", err);
      res.status(500).json({
        error: "Failed to fetch route details",
        details: err instanceof Error ? err.message : "Unknown error"
      });
    }
  });




  // ============================================
  // ENGINEER ROUTES ENDPOINTS
  // ============================================

  // 1. GET ENGINEER'S ROUTES (with filters)
  // If no date provided → defaults to TODAY
  app.get("/api/engineers/:id/routes", async (req, res) => {
    try {
      const { id } = req.params;
      const { date, status } = req.query;

      const today = new Date().toISOString().split("T")[0];
      const filterDate = date || today;

      console.log(`📍 Fetching routes for engineer: ${id}, date: ${filterDate}, status: ${status}`);

      let query = supabase
        .from("routes")
        .select("*")
        .eq("engineer_id", id)
        .order("date", { ascending: false });

      if (filterDate !== "all") {
        query = query.eq("date", filterDate);
      }

      if (status && status !== "all") {
        query = query.eq("status", status);
      }

      const { data: routes, error: routesError } = await query;

      if (routesError) {
        console.error("❌ Error fetching routes:", routesError);
        return res.status(500).json({ error: "Failed to fetch routes" });
      }

      const routesWithJobs = await Promise.all(
        (routes || []).map(async (route) => {
          const { data: jobs, error: jobsError } = await supabase
            .from("jobs")
            .select("*")
            .eq("route_id", route.id)
            .order("route_order", { ascending: true });

          if (jobsError) {
            console.error(`⚠️ Error fetching jobs for route ${route.id}:`, jobsError);
          }

          const totalJobs = jobs?.length || 0;
          const completedJobs = jobs?.filter((j) => isJobCompleted(j.job_status)).length || 0;
          const inProgressJobs = jobs?.filter((j) => isJobInProgress(j.job_status)).length || 0;
          const pendingJobs = totalJobs - completedJobs - inProgressJobs;

          return {
            ...route,
            jobs: jobs || [],
            stats: {
              total_jobs: totalJobs,
              completed_jobs: completedJobs,
              in_progress_jobs: inProgressJobs,
              pending_jobs: pendingJobs,
              completion_percentage: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
            },
            can_start: route.status === "scheduled",
            can_complete: completedJobs === totalJobs && totalJobs > 0 && route.status === "in_progress",
            can_cancel: route.status === "scheduled",
          };
        })
      );

      console.log(`✅ Found ${routesWithJobs.length} routes for engineer ${id}`);

      res.json({
        routes: routesWithJobs,
        count: routesWithJobs.length,
      });
    } catch (err) {
      console.error("🔥 Error in GET /api/engineers/:id/routes:", err);
      res.status(500).json({
        error: "Failed to fetch routes",
        details: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  // 2. GET SINGLE ROUTE DETAILS FOR ENGINEER
  app.get("/api/engineers/:engineerId/routes/:routeId", async (req, res) => {
    try {
      const { engineerId, routeId } = req.params;

      const { data: route, error: routeError } = await supabase
        .from("routes")
        .select("*")
        .eq("id", routeId)
        .eq("engineer_id", engineerId)
        .single();

      if (routeError || !route) {
        return res.status(404).json({ error: "Route not found" });
      }

      const { data: jobs, error: jobsError } = await supabase
        .from("jobs")
        .select("*")
        .eq("route_id", routeId)
        .order("route_order", { ascending: true });

      const totalJobs = jobs?.length || 0;
      const completedJobs = jobs?.filter((j) => isJobCompleted(j.job_status)).length || 0;
      const inProgressJobs = jobs?.filter((j) => isJobInProgress(j.job_status)).length || 0;

      res.json({
        route: {
          ...route,
          jobs: jobs || [],
          stats: {
            total_jobs: totalJobs,
            completed_jobs: completedJobs,
            in_progress_jobs: inProgressJobs,
            pending_jobs: totalJobs - completedJobs - inProgressJobs,
            completion_percentage: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
          },
          can_start: route.status === "scheduled",
          can_complete: completedJobs === totalJobs && totalJobs > 0 && route.status === "in_progress",
          can_cancel: route.status === "scheduled",
        },
      });
    } catch (err) {
      console.error("🔥 Error fetching route details:", err);
      res.status(500).json({ error: "Failed to fetch route details" });
    }
  });

  // 3. START ROUTE (scheduled → in_progress)
  app.put("/api/engineers/:engineerId/routes/:routeId/start", async (req, res) => {
    try {
      const { engineerId, routeId } = req.params;

      const { data: route, error: routeError } = await supabase
        .from("routes")
        .select("*")
        .eq("id", routeId)
        .eq("engineer_id", engineerId)
        .single();

      if (routeError || !route) {
        return res.status(404).json({ error: "Route not found" });
      }

      if (route.status !== "scheduled") {
        return res.status(400).json({
          error: `Cannot start route. Current status is '${route.status}'. Only 'scheduled' routes can be started.`,
        });
      }

      const { data: updatedRoute, error: updateError } = await supabase
        .from("routes")
        .update({
          status: "in_progress",
          started_at: new Date().toISOString(),
        })
        .eq("id", routeId)
        .select()
        .single();

      if (updateError) {
        return res.status(500).json({ error: "Failed to start route" });
      }

      // Fetch jobs to return updated stats
      const { data: jobs } = await supabase
        .from("jobs")
        .select("*")
        .eq("route_id", routeId);

      const totalJobs = jobs?.length || 0;
      const completedJobs = jobs?.filter((j) => isJobCompleted(j.job_status)).length || 0;

      console.log(`✅ Route ${routeId} started successfully`);

      res.json({
        success: true,
        message: "Route started successfully",
        route: {
          ...updatedRoute,
          can_start: false,
          can_complete: completedJobs === totalJobs && totalJobs > 0,
          can_cancel: false,
        },
        stats: {
          total_jobs: totalJobs,
          completed_jobs: completedJobs,
        },
      });
    } catch (err) {
      console.error("🔥 Error starting route:", err);
      res.status(500).json({ error: "Failed to start route" });
    }
  });

  // 4. COMPLETE ROUTE (in_progress → completed)
  app.put("/api/engineers/:engineerId/routes/:routeId/complete", async (req, res) => {
    try {
      const { engineerId, routeId } = req.params;

      const { data: route, error: routeError } = await supabase
        .from("routes")
        .select("*")
        .eq("id", routeId)
        .eq("engineer_id", engineerId)
        .single();

      if (routeError || !route) {
        return res.status(404).json({ error: "Route not found" });
      }

      if (route.status !== "in_progress") {
        return res.status(400).json({
          error: `Cannot complete route. Current status is '${route.status}'. Only 'in_progress' routes can be completed.`,
        });
      }

      const { data: jobs, error: jobsError } = await supabase
        .from("jobs")
        .select("id, job_status")
        .eq("route_id", routeId);

      const totalJobs = jobs?.length || 0;
      const completedJobs = jobs?.filter((j) => isJobCompleted(j.job_status)).length || 0;

      if (totalJobs === 0) {
        return res.status(400).json({ error: "No jobs found in this route" });
      }

      if (completedJobs < totalJobs) {
        const pendingJobs = totalJobs - completedJobs;
        const incompleteJobStatuses = jobs
          ?.filter((j) => !isJobCompleted(j.job_status))
          .map((j) => j.job_status);

        return res.status(400).json({
          error: `Cannot complete route. ${pendingJobs} job(s) still pending.`,
          details: {
            total_jobs: totalJobs,
            completed_jobs: completedJobs,
            pending_jobs: pendingJobs,
            incomplete_statuses: incompleteJobStatuses,
          },
        });
      }

      const { data: updatedRoute, error: updateError } = await supabase
        .from("routes")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", routeId)
        .select()
        .single();

      if (updateError) {
        return res.status(500).json({ error: "Failed to complete route" });
      }

      console.log(`✅ Route ${routeId} completed successfully`);

      res.json({
        success: true,
        message: "Route completed successfully",
        route: {
          ...updatedRoute,
          can_start: false,
          can_complete: false,
          can_cancel: false,
        },
        stats: {
          total_jobs: totalJobs,
          completed_jobs: completedJobs,
        },
      });
    } catch (err) {
      console.error("🔥 Error completing route:", err);
      res.status(500).json({ error: "Failed to complete route" });
    }
  });


  // 5. CANCEL ROUTE (only if scheduled, NOT in_progress)
  app.put("/api/engineers/:engineerId/routes/:routeId/cancel", async (req, res) => {
    try {
      const { engineerId, routeId } = req.params;
      const { reason } = req.body;

      const { data: route, error: routeError } = await supabase
        .from("routes")
        .select("*")
        .eq("id", routeId)
        .eq("engineer_id", engineerId)
        .single();

      if (routeError || !route) {
        return res.status(404).json({ error: "Route not found" });
      }

      if (route.status !== "scheduled") {
        return res.status(400).json({
          error: `Cannot cancel route. Current status is '${route.status}'. Only 'scheduled' routes can be cancelled.`,
        });
      }

      // First get jobs before updating route
      const { data: jobs } = await supabase
        .from("jobs")
        .select("customer_id")
        .eq("route_id", routeId);

      const customerIds = jobs?.map((j) => j.customer_id) || [];

      // Update route status
      const { data: updatedRoute, error: updateError } = await supabase
        .from("routes")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancellation_reason: reason || null,
        })
        .eq("id", routeId)
        .select()
        .single();

      if (updateError) {
        return res.status(500).json({ error: "Failed to cancel route" });
      }

      // Update all jobs in this route
      await supabase
        .from("jobs")
        .update({
          job_status: "Cancelled",
          route_id: null,
          route_order: null,
        })
        .eq("route_id", routeId);

      // Update customer statuses
      if (customerIds.length > 0) {
        await supabase
          .from("customers")
          .update({
            status: "new",
            assigned_engineer: null,
            scheduled_time: null,
          })
          .in("id", customerIds);
      }

      console.log(`✅ Route ${routeId} cancelled successfully`);

      res.json({
        success: true,
        message: "Route cancelled successfully",
        route: {
          ...updatedRoute,
          can_start: false,
          can_complete: false,
          can_cancel: false,
        },
        jobs_cancelled: jobs?.length || 0,
      });
    } catch (err) {
      console.error("🔥 Error cancelling route:", err);
      res.status(500).json({ error: "Failed to cancel route" });
    }
  });







  /* ===========================
     UPDATE ENGINEER LOCATION - ENGINEER AUTH REQUIRED
     Updates engineer's latitude and longitude in the database
  ============================*/
  app.put("/api/engineers/:id/location", async (req, res) => {
    try {
      const { id } = req.params;
      const { latitude, longitude } = req.body;

      // Validate coordinates
      if (
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return res.status(400).json({
          error:
            "Invalid coordinates. Latitude must be -90 to 90, longitude -180 to 180",
        });
      }

      // Update engineer location in database
      const { data: updatedEngineer, error } = await supabase
        .from("engineers")
        .update({
          latitude,
          longitude,
        })
        .eq("id", id)
        .select()
        .single();

      if (error) {
        console.error("Error updating engineer location:", error);
        return res.status(400).json({ error: error.message });
      }

      console.log(
        `📍 Updated location for engineer ${id}: [${latitude}, ${longitude}]`
      );
      res.json({
        success: true,
        engineer: updatedEngineer,
        message: "Location updated successfully",
      });
    } catch (err) {
      console.error("Error in PUT /api/engineers/:id/location:", err);
      res.status(500).json({ error: "Failed to update engineer location" });
    }
  });









  ///////////////////////////=====================================serever is runnning check api
  app.get("/health", (req, res) => {
    res.send("Server is running");
  });

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

  /* ===========================
     ENGINEERS MANAGEMENT - ADMIN ONLY
  ============================*/

  // GET all engineers with pagination and search
  app.get(
    "/api/engineers",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const {
          page = "1",
          limit = "10",
          search = "",
          status = "",
        } = req.query;

        const pageNum = parseInt(page as string);
        const limitNum = parseInt(limit as string);
        const offset = (pageNum - 1) * limitNum;

        // Build the base query
        let engineersQuery = supabase
          .from("engineers")
          .select("*", { count: "exact" });

        // Apply search filter if provided
        if (search) {
          engineersQuery = engineersQuery.or(
            `eng_name.ilike.%${search}%,email.ilike.%${search}%,area.ilike.%${search}%,speciality.ilike.%${search}%`
          );
        }

        // Apply status filter if provided
        if (status && status !== "all") {
          engineersQuery = engineersQuery.eq("working_status", status);
        }

        // Get total count first
        const { count: totalCount } = await engineersQuery;

        // Now get paginated results
        const { data, error } = await engineersQuery
          .order("created_at", { ascending: false })
          .range(offset, offset + limitNum - 1);

        if (error) {
          console.error("Error fetching engineers:", error);
          return res.status(500).json({ error: error.message });
        }

        // Calculate pagination metadata
        const totalPages = Math.ceil((totalCount || 0) / limitNum);

        res.json({
          data: data || [],
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: totalCount || 0,
            totalPages,
            hasNextPage: pageNum < totalPages,
            hasPreviousPage: pageNum > 1,
          },
        });
      } catch (err) {
        console.error("Error in /api/engineers:", err);
        res.status(500).json({ error: "Failed to fetch engineers" });
      }
    }
  );

  // CREATE new engineer
  app.post(
    "/api/engineers",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const {
          email,
          password,
          eng_name,
          speciality,
          area,
          working_status,
          work_start_time,
          work_end_time,
          latitude,
          longitude,
        } = req.body;

        // Validate required fields
        if (!email || !password || !eng_name || !speciality || !area) {
          return res.status(400).json({
            error: "Missing required fields",
            required: ["email", "password", "eng_name", "speciality", "area"],
          });
        }

        // Format times with timezone
        const formatTimeWithTimezone = (time: string) => {
          if (!time) return null;
          return time.includes(":") ? `${time}:00+00:00` : `${time}+00:00`;
        };

        // Create auth user
        const { data: authData, error: authError } =
          await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          });

        if (authError || !authData.user) {
          return res.status(400).json({
            error: authError?.message || "Failed to create account",
          });
        }

        // Insert engineer record
        const { data: engineerData, error: engineerError } = await supabase
          .from("engineers")
          .insert({
            id: authData.user.id,
            email,
            eng_name,
            speciality,
            area,
            working_status: working_status || "active",
            work_start_time: formatTimeWithTimezone(work_start_time),
            work_end_time: formatTimeWithTimezone(work_end_time),
            latitude: latitude || null,
            longitude: longitude || null,
          })
          .select()
          .single();

        if (engineerError) {
          console.error("Engineer insert error:", engineerError);
          // Rollback: delete auth user
          await supabase.auth.admin.deleteUser(authData.user.id);
          return res.status(400).json({
            error: engineerError.message,
            details: engineerError.details,
          });
        }

        res.json({
          success: true,
          message: "Engineer created successfully",
          engineer: engineerData,
        });
      } catch (err) {
        console.error("Error creating engineer:", err);
        res.status(500).json({ error: "Failed to create engineer" });
      }
    }
  );

  // UPDATE engineer
  app.patch(
    "/api/engineers/:id",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { id } = req.params;
        const {
          eng_name,
          email,
          speciality,
          area,
          working_status,
          work_start_time,
          work_end_time,
          latitude,
          longitude,
        } = req.body;

        // Format times with timezone if provided
        const formatTimeWithTimezone = (time: string | undefined) => {
          if (!time) return undefined;
          return time.includes(":") ? `${time}:00+00:00` : `${time}+00:00`;
        };

        const updateData: any = {};
        if (eng_name !== undefined) updateData.eng_name = eng_name;
        if (email !== undefined) updateData.email = email;
        if (speciality !== undefined) updateData.speciality = speciality;
        if (area !== undefined) updateData.area = area;
        if (working_status !== undefined)
          updateData.working_status = working_status;
        if (work_start_time !== undefined)
          updateData.work_start_time = formatTimeWithTimezone(work_start_time);
        if (work_end_time !== undefined)
          updateData.work_end_time = formatTimeWithTimezone(work_end_time);
        if (latitude !== undefined) updateData.latitude = latitude;
        if (longitude !== undefined) updateData.longitude = longitude;

        const { data, error } = await supabase
          .from("engineers")
          .update(updateData)
          .eq("id", id)
          .select()
          .single();

        if (error) {
          console.error("Error updating engineer:", error);
          return res.status(400).json({ error: error.message });
        }

        // Update auth email if changed
        if (email) {
          const { error: authError } = await supabase.auth.admin.updateUserById(
            id,
            { email }
          );

          if (authError) {
            console.error("Error updating auth email:", authError);
          }
        }

        res.json({
          success: true,
          message: "Engineer updated successfully",
          engineer: data,
        });
      } catch (err) {
        console.error("Error updating engineer:", err);
        res.status(500).json({ error: "Failed to update engineer" });
      }
    }
  );

  // DELETE engineer
  app.delete(
    "/api/engineers/:id",
    requireAdminAuth,
    async (req: AdminRequest, res) => {
      try {
        const { id } = req.params;

        // Check if engineer has active jobs
        const { count: activeJobs } = await supabase
          .from("jobs")
          .select("*", { count: "exact", head: true })
          .eq("engineer_uuid", id)
          .in("job_status", ["Assigned", "In Progress", "Quoted", "Working"]);

        if (activeJobs && activeJobs > 0) {
          return res.status(400).json({
            error: "Cannot delete engineer with active jobs",
            activeJobs,
          });
        }

        // Delete engineer record
        const { error: deleteError } = await supabase
          .from("engineers")
          .delete()
          .eq("id", id);

        if (deleteError) {
          console.error("Error deleting engineer:", deleteError);
          return res.status(400).json({ error: deleteError.message });
        }

        // Delete auth user
        const { error: authError } = await supabase.auth.admin.deleteUser(id);

        if (authError) {
          console.error("Error deleting auth user:", authError);
        }

        res.json({
          success: true,
          message: "Engineer deleted successfully",
        });
      } catch (err) {
        console.error("Error deleting engineer:", err);
        res.status(500).json({ error: "Failed to delete engineer" });
      }
    }
  );

  const httpServer = createServer(app);
  return httpServer;
}
