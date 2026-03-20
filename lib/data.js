export const BRANDS = [
  { id: "carstar", name: "CARSTAR", color: "#E31837", locationCount: 42 },
  { id: "take5", name: "Take 5 Oil Change", color: "#0066CC", locationCount: 118 },
  { id: "autoglass", name: "Auto Glass Now", color: "#00875A", locationCount: 67 },
];

export const LOCATIONS = [
  { id: "loc-001", brand: "carstar", name: "CARSTAR Grand Rapids South", address: "2845 28th St SE", city: "Grand Rapids", state: "MI", zip: "49512", phone: "(616) 555-0142", website: "https://carstar.com/locations/mi/grand-rapids-south", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-14", updatedBy: "Barry S." },
  { id: "loc-002", brand: "carstar", name: "CARSTAR Kalamazoo", address: "5100 W Main St", city: "Kalamazoo", state: "MI", zip: "49009", phone: "(269) 555-0198", website: "https://carstar.com/locations/mi/kalamazoo", status: "active", hoursStatus: "holiday", lastUpdated: "2026-03-12", updatedBy: "Maria T." },
  { id: "loc-003", brand: "carstar", name: "CARSTAR Traverse City", address: "1440 S Airport Rd", city: "Traverse City", state: "MI", zip: "49686", phone: "(231) 555-0623", website: "https://carstar.com/locations/mi/traverse-city", status: "active", hoursStatus: "modified", lastUpdated: "2026-03-09", updatedBy: "James R." },
  { id: "loc-004", brand: "carstar", name: "CARSTAR Lansing East", address: "3920 E Michigan Ave", city: "Lansing", state: "MI", zip: "48912", phone: "(517) 555-0334", website: "https://carstar.com/locations/mi/lansing-east", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-11", updatedBy: "Maria T." },
  { id: "loc-005", brand: "carstar", name: "CARSTAR Ann Arbor", address: "2780 S State St", city: "Ann Arbor", state: "MI", zip: "48104", phone: "(734) 555-0456", website: "https://carstar.com/locations/mi/ann-arbor", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-08", updatedBy: "Barry S." },
  { id: "loc-006", brand: "take5", name: "Take 5 Oil Change - Wyoming", address: "1025 36th St SW", city: "Wyoming", state: "MI", zip: "49509", phone: "(616) 555-0277", website: "https://take5.com/locations/mi/wyoming", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-16", updatedBy: "Barry S." },
  { id: "loc-007", brand: "take5", name: "Take 5 Oil Change - Holland", address: "680 E 16th St", city: "Holland", state: "MI", zip: "49423", phone: "(616) 555-0331", website: "https://take5.com/locations/mi/holland", status: "temp_closed", hoursStatus: "closed", lastUpdated: "2026-03-10", updatedBy: "James R." },
  { id: "loc-008", brand: "take5", name: "Take 5 Oil Change - Muskegon", address: "1875 E Sherman Blvd", city: "Muskegon", state: "MI", zip: "49444", phone: "(231) 555-0744", website: "https://take5.com/locations/mi/muskegon", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-17", updatedBy: "Barry S." },
  { id: "loc-009", brand: "take5", name: "Take 5 Oil Change - Portage", address: "6321 S Westnedge Ave", city: "Portage", state: "MI", zip: "49024", phone: "(269) 555-0188", website: "https://take5.com/locations/mi/portage", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-13", updatedBy: "James R." },
  { id: "loc-010", brand: "take5", name: "Take 5 Oil Change - Detroit", address: "18901 W 8 Mile Rd", city: "Detroit", state: "MI", zip: "48219", phone: "(313) 555-0522", website: "https://take5.com/locations/mi/detroit-8mile", status: "active", hoursStatus: "modified", lastUpdated: "2026-03-15", updatedBy: "Barry S." },
  { id: "loc-011", brand: "take5", name: "Take 5 Oil Change - Canton", address: "42045 Michigan Ave", city: "Canton", state: "MI", zip: "48188", phone: "(734) 555-0633", website: "https://take5.com/locations/mi/canton", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-14", updatedBy: "James R." },
  { id: "loc-012", brand: "autoglass", name: "Auto Glass Now - Grand Rapids", address: "3300 Broadmoor Ave SE", city: "Grand Rapids", state: "MI", zip: "49512", phone: "(616) 555-0455", website: "https://autoglassnow.com/locations/mi/grand-rapids", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-15", updatedBy: "Barry S." },
  { id: "loc-013", brand: "autoglass", name: "Auto Glass Now - Lansing", address: "5827 S Cedar St", city: "Lansing", state: "MI", zip: "48911", phone: "(517) 555-0512", website: "https://autoglassnow.com/locations/mi/lansing", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-11", updatedBy: "Maria T." },
  { id: "loc-014", brand: "autoglass", name: "Auto Glass Now - Flint", address: "4422 Corunna Rd", city: "Flint", state: "MI", zip: "48532", phone: "(810) 555-0677", website: "https://autoglassnow.com/locations/mi/flint", status: "active", hoursStatus: "standard", lastUpdated: "2026-03-10", updatedBy: "James R." },
  { id: "loc-015", brand: "autoglass", name: "Auto Glass Now - Saginaw", address: "2850 Bay Rd", city: "Saginaw", state: "MI", zip: "48603", phone: "(989) 555-0788", website: "https://autoglassnow.com/locations/mi/saginaw", status: "temp_closed", hoursStatus: "closed", lastUpdated: "2026-03-09", updatedBy: "Maria T." },
];

export const ACTIVITY_LOG = [
  { id: "act-001", time: "2026-03-19T10:42:00", user: "Barry S.", action: "Updated hours", location: "Take 5 - Muskegon", brand: "take5", details: "Changed Saturday hours to 9:00 AM - 4:00 PM" },
  { id: "act-002", time: "2026-03-19T10:15:00", user: "Barry S.", action: "Updated phone", location: "Auto Glass Now - Grand Rapids", brand: "autoglass", details: "Changed phone to (616) 555-0455" },
  { id: "act-003", time: "2026-03-19T09:58:00", user: "Maria T.", action: "Bulk hours update", location: "CARSTAR — 4 locations", brand: "carstar", details: "Applied holiday hours for Easter weekend" },
  { id: "act-004", time: "2026-03-19T09:30:00", user: "James R.", action: "Marked temp closed", location: "Take 5 - Holland", brand: "take5", details: "Renovation — expected reopen April 15" },
  { id: "act-005", time: "2026-03-18T16:20:00", user: "Barry S.", action: "Updated address", location: "CARSTAR Grand Rapids South", brand: "carstar", details: "Corrected suite number" },
  { id: "act-006", time: "2026-03-18T14:45:00", user: "Maria T.", action: "Bulk phone update", location: "Auto Glass Now — 3 locations", brand: "autoglass", details: "Area code migration from 616 to 269" },
  { id: "act-007", time: "2026-03-18T11:10:00", user: "James R.", action: "Updated website", location: "Take 5 - Portage", brand: "take5", details: "Updated to new location page URL" },
  { id: "act-008", time: "2026-03-17T15:33:00", user: "Barry S.", action: "Updated hours", location: "Take 5 - Detroit", brand: "take5", details: "Extended weekday hours to 7 PM" },
  { id: "act-009", time: "2026-03-17T13:22:00", user: "Maria T.", action: "Updated phone", location: "CARSTAR Lansing East", brand: "carstar", details: "New phone number assigned" },
  { id: "act-010", time: "2026-03-17T10:05:00", user: "James R.", action: "Reopened location", location: "Auto Glass Now - Flint", brand: "autoglass", details: "Renovation complete, back to standard hours" },
];

export const DEFAULT_HOURS = {
  monday: { open: "08:00", close: "18:00", closed: false },
  tuesday: { open: "08:00", close: "18:00", closed: false },
  wednesday: { open: "08:00", close: "18:00", closed: false },
  thursday: { open: "08:00", close: "18:00", closed: false },
  friday: { open: "08:00", close: "18:00", closed: false },
  saturday: { open: "09:00", close: "16:00", closed: false },
  sunday: { open: "00:00", close: "00:00", closed: true },
};

export const ROLES = [
  { id: "admin", label: "Admin", description: "Full access — manage users, all brands, all locations" },
  { id: "manager", label: "Manager", description: "Edit locations, run bulk updates, view activity" },
  { id: "editor", label: "Editor", description: "Edit assigned brand locations only" },
  { id: "viewer", label: "Viewer", description: "View-only access to locations and activity" },
];
