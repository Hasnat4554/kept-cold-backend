import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, decimal, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
// import { 
//   users, jobs, quotes, technicians, jobAssignments, timeEntries, 
//   parts, inventories, stockMovements, signatures, attachments, checklists 
// } from "./database";
// import { z } from "zod";
// import { 
//   insertUserSchema, insertJobSchema, insertQuoteSchema, insertTechnicianSchema,
//   insertJobAssignmentSchema, insertTimeEntrySchema, insertPartSchema,
//   insertInventorySchema, insertStockMovementSchema, insertSignatureSchema,
//   insertAttachmentSchema, insertChecklistSchema
// } from "./validation";



export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const jobs = pgTable("jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  reference: text("reference").notNull().unique(),
  clientName: text("client_name").notNull(),
  clientPhone: text("client_phone").notNull(),
  clientEmail: text("client_email"),
  address: text("address").notNull(),
  latitude: decimal("latitude", { precision: 10, scale: 7 }),
  longitude: decimal("longitude", { precision: 10, scale: 7 }),
  jobType: text("job_type").notNull(),
  description: text("description"),
  priority: text("priority").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  scheduledDate: timestamp("scheduled_date"),
  estimatedDuration: integer("estimated_duration"),
  engineerNotes: text("engineer_notes"),
  addedToTradify: boolean("added_to_tradify").default(false),
  revenue: decimal("revenue", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const quotes = pgTable("quotes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => jobs.id),
  status: text("status").notNull(),
  laborHours: decimal("labor_hours", { precision: 5, scale: 2 }),
  laborRate: decimal("labor_rate", { precision: 10, scale: 2 }),
  vatIncluded: boolean("vat_included").default(true),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const technicians = pgTable("technicians", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  employeeId: text("employee_id").notNull().unique(),
  role: text("role").notNull().default("technician"),
  active: boolean("active").default(true),
  profilePhoto: text("profile_photo"),
  certifications: text("certifications").array(),
});

export const jobAssignments = pgTable("job_assignments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => jobs.id).notNull(),
  technicianId: varchar("technician_id").references(() => technicians.id).notNull(),
  status: text("status").notNull(),
  scheduledStart: timestamp("scheduled_start"),
  scheduledEnd: timestamp("scheduled_end"),
  actualStart: timestamp("actual_start"),
  actualEnd: timestamp("actual_end"),
  notes: text("notes"),
});

export const timeEntries = pgTable("time_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").references(() => technicians.id).notNull(),
  jobId: varchar("job_id").references(() => jobs.id),
  type: text("type").notNull(),
  startedAt: timestamp("started_at").notNull(),
  endedAt: timestamp("ended_at"),
  notes: text("notes"),
  location: text("location"),
});

export const parts = pgTable("parts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  sku: text("sku").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
  vatRate: decimal("vat_rate", { precision: 5, scale: 2 }).default("20"),
  supplier: text("supplier"),
  trackStock: boolean("track_stock").default(true),
});

export const inventories = pgTable("inventories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  technicianId: varchar("technician_id").references(() => technicians.id).notNull(),
  partId: varchar("part_id").references(() => parts.id).notNull(),
  quantity: integer("quantity").notNull().default(0),
  lastUpdated: timestamp("last_updated").defaultNow(),
});

export const stockMovements = pgTable("stock_movements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  partId: varchar("part_id").references(() => parts.id).notNull(),
  technicianId: varchar("technician_id").references(() => technicians.id),
  jobId: varchar("job_id").references(() => jobs.id),
  qtyChange: integer("qty_change").notNull(),
  reason: text("reason").notNull(),
  occurredAt: timestamp("occurred_at").defaultNow(),
  notes: text("notes"),
});

export const signatures = pgTable("signatures", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => jobs.id).notNull(),
  signedByName: text("signed_by_name").notNull(),
  signedAt: timestamp("signed_at").defaultNow(),
  blobRef: text("blob_ref").notNull(),
  hash: text("hash"),
});

export const attachments = pgTable("attachments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => jobs.id).notNull(),
  type: text("type").notNull(),
  blobRef: text("blob_ref").notNull(),
  caption: text("caption"),
  takenAt: timestamp("taken_at").defaultNow(),
  takenBy: varchar("taken_by").references(() => technicians.id),
});

export const checklists = pgTable("checklists", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  jobId: varchar("job_id").references(() => jobs.id).notNull(),
  items: text("items").array().notNull(),
  completedItems: text("completed_items").array().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});


export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertJobSchema = createInsertSchema(jobs).omit({
  id: true,
  createdAt: true,
});

export const insertQuoteSchema = createInsertSchema(quotes).omit({
  id: true,
  createdAt: true,
});

export const insertTechnicianSchema = createInsertSchema(technicians).omit({
  id: true,
});

export const insertJobAssignmentSchema = createInsertSchema(jobAssignments).omit({
  id: true,
});

export const insertTimeEntrySchema = createInsertSchema(timeEntries).omit({
  id: true,
});

export const insertPartSchema = createInsertSchema(parts).omit({
  id: true,
});

export const insertInventorySchema = createInsertSchema(inventories).omit({
  id: true,
});

export const insertStockMovementSchema = createInsertSchema(stockMovements).omit({
  id: true,
});

export const insertSignatureSchema = createInsertSchema(signatures).omit({
  id: true,
});

export const insertAttachmentSchema = createInsertSchema(attachments).omit({
  id: true,
});

export const insertChecklistSchema = createInsertSchema(checklists).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});


export type InsertUser = z.infer<typeof insertUserSchema>;
export type InsertJob = z.infer<typeof insertJobSchema>;
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type InsertTechnician = z.infer<typeof insertTechnicianSchema>;
export type InsertJobAssignment = z.infer<typeof insertJobAssignmentSchema>;
export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type InsertPart = z.infer<typeof insertPartSchema>;
export type InsertInventory = z.infer<typeof insertInventorySchema>;
export type InsertStockMovement = z.infer<typeof insertStockMovementSchema>;
export type InsertSignature = z.infer<typeof insertSignatureSchema>;
export type InsertAttachment = z.infer<typeof insertAttachmentSchema>;
export type InsertChecklist = z.infer<typeof insertChecklistSchema>;

// Database entity types
export interface User {
  id: string;
  username: string;
  password: string;
}

export interface Job {
  id: string;
  reference: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  address: string;
  latitude: string | null;
  longitude: string | null;
  jobType: string;
  description: string | null;
  priority: string;
  status: string;
  source: string;
  scheduledDate: Date | null;
  estimatedDuration: number | null;
  engineerNotes: string | null;
  addedToTradify: boolean;
  revenue: string | null;
  createdAt: Date;
}

export interface Quote {
  id: string;
  jobId: string | null;
  status: string;
  laborHours: string | null;
  laborRate: string | null;
  vatIncluded: boolean;
  totalAmount: string | null;
  createdAt: Date;
}

export interface Technician {
  id: string;
  name: string;
  email: string;
  phone: string;
  employeeId: string;
  role: string;
  active: boolean;
  profilePhoto: string | null;
  certifications: string[] | null;
}

export interface JobAssignment {
  id: string;
  jobId: string;
  technicianId: string;
  status: string;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  notes: string | null;
}

export interface TimeEntry {
  id: string;
  technicianId: string;
  jobId: string | null;
  type: string;
  startedAt: Date;
  endedAt: Date | null;
  notes: string | null;
  location: string | null;
}

export interface Part {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  unitPrice: string;
  vatRate: string;
  supplier: string | null;
  trackStock: boolean;
}

export interface Inventory {
  id: string;
  technicianId: string;
  partId: string;
  quantity: number;
  lastUpdated: Date;
}

export interface StockMovement {
  id: string;
  partId: string;
  technicianId: string | null;
  jobId: string | null;
  qtyChange: number;
  reason: string;
  occurredAt: Date;
  notes: string | null;
}

export interface Signature {
  id: string;
  jobId: string;
  signedByName: string;
  signedAt: Date;
  blobRef: string;
  hash: string | null;
}

export interface Attachment {
  id: string;
  jobId: string;
  type: string;
  blobRef: string;
  caption: string | null;
  takenAt: Date;
  takenBy: string | null;
}

export interface Checklist {
  id: string;
  jobId: string;
  items: string[];
  completedItems: string[];
  createdAt: Date;
  updatedAt: Date;
}


export const engineerRegistrationSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  eng_name: z.string().min(2, "Full name is required"),
  speciality: z.string().min(2, "Speciality is required"),
  area: z.string().min(2, "Area/location is required"),
  working_status: z.string().min(1, "Working status is required"),
  work_start_time: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "Time must be in HH:MM format"),
  work_end_time: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, "Time must be in HH:MM format"),
});

export type EngineerRegistration = z.infer<typeof engineerRegistrationSchema>;