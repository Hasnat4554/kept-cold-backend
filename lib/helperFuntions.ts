export const isJobCompleted = (jobStatus: string | null): boolean => {
    if (!jobStatus) return false;
    const status = jobStatus.toLowerCase();
    return ["completed", "invoiced", "1streminder", "2ndreminder", "paid"].includes(status);
};

export const isJobInProgress = (jobStatus: string | null): boolean => {
    if (!jobStatus) return false;
    const status = jobStatus.toLowerCase();
    return status === "in progress" || status === "inprogress";
};