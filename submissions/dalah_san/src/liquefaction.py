"""
Liquefaction Analysis Module
Contains core algorithms, stress calculation, plotting, and Excel output.
"""

import numpy as np
import pandas as pd
import io

def _lazy_mpl_pyplot():
    """
    Lazy import matplotlib to avoid slow import/font cache costs when only doing computations.
    """
    import matplotlib
    try:
        matplotlib.use('Agg')  # non-interactive backend
    except Exception:
        pass
    import matplotlib.pyplot as plt
    return matplotlib, plt

# ==========================================
# Unit conversion functions
# ==========================================
def convert_to_imperial(df, unit_system='imperial'):
    """
    Convert data from metric to imperial if needed.
    If already imperial, no conversion.
    """
    if unit_system == 'imperial':
        # If input is metric, convert:
        # Depth: m -> ft (1 m = 3.28084 ft)
        # Stress: kPa -> tsf (1 kPa = 0.01044 tsf, or 1 tsf = 95.76 kPa)
        # Unit weight: kN/m³ -> pcf (1 kN/m³ = 6.36588 pcf)
        
        df_converted = df.copy()
        
        # Convert depth
        if 'depth' in df_converted.columns:
            df_converted['depth'] = df_converted['depth'] * 3.28084
        
        # Convert stress
        if 'sigma_v' in df_converted.columns:
            df_converted['sigma_v'] = df_converted['sigma_v'] * 0.01044  # kPa to tsf
        if 'sigma_ve' in df_converted.columns:
            df_converted['sigma_ve'] = df_converted['sigma_ve'] * 0.01044  # kPa to tsf
        
        # Convert unit weight
        if 'gamma' in df_converted.columns:
            df_converted['gamma'] = df_converted['gamma'] * 6.36588  # kN/m³ to pcf
        
        return df_converted
    else:
        # Metric; no conversion needed
        return df.copy()

def get_unit_labels(unit_system='imperial'):
    """Return unit labels based on unit system."""
    if unit_system == 'imperial':
        return {
            'depth': 'Depth\n(ft)',
            'gamma': 'Unit Wt\n(pcf)',
            'sigma_v': 'σv\n(tsf)',
            'sigma_ve': 'σ\'v\n(tsf)',
            'depth_label': 'Depth (ft)',
            'gwt_unit': 'ft',
            'pa_unit': 'tsf'
        }
    else:  # metric
        return {
            'depth': 'Depth\n(m)',
            'gamma': 'Unit Wt\n(kN/m³)',
            'sigma_v': 'σv\n(kPa)',
            'sigma_ve': 'σ\'v\n(kPa)',
            'depth_label': 'Depth (m)',
            'gwt_unit': 'm',
            'pa_unit': 'kPa'
        }

# ==========================================
# Core algorithm A: Idriss & Boulanger (2014)
# ==========================================

class IdrissBoulanger2014:
    def __init__(self, Mw, PGA, Pa=101.325, CE=0.60):
        self.Mw = float(Mw)
        self.PGA = float(PGA)
        self.Pa = Pa
        self.CE = float(CE)  # Energy Ratio (default 0.60 = 60%)

    def _is_clay_like(self, PI):
        try:
            if PI is None:
                return False
            PI = float(PI)
        except Exception:
            return False
        return PI >= 7.0

    def calculate_rd(self, depth):
        """Stress reduction factor rd"""
        z = float(depth)
        Mw = float(self.Mw)
        
        # Validate input
        if np.isnan(z) or np.isinf(z) or z < 0:
            return 1.0
        if np.isnan(Mw) or np.isinf(Mw):
            return 1.0
        
        try:
            alpha = -1.012 - 1.126 * np.sin(z/11.73 + 5.133)
            beta = 0.106 + 0.118 * np.sin(z/11.28 + 5.142)
            rd = np.exp(alpha + beta * Mw)
            
            # Validate result
            if np.isnan(rd) or np.isinf(rd):
                return 1.0
            
            return min(max(rd, 0.0), 1.0)  # Clamp to [0, 1]
        except (ValueError, OverflowError):
            return 1.0

    def solve_N1_60cs(self, N_measured, sigma_v_eff, FC):
        """
        Iterative loop (I&B 2014): CN depends on (N1)60cs and (N1)60cs depends on CN.

        Returns a dict with all intermediate terms so the Excel can be fully auditable.
        Convergence criterion follows the blueprint: |CN_new - CN_old| <= 0.001.
        """
        Pa = float(self.Pa)

        try:
            N = float(N_measured)
        except Exception:
            N = 0.0

        try:
            FC = float(FC)
        except Exception:
            FC = 0.0

        try:
            sigma_v_eff = float(sigma_v_eff)
        except Exception:
            sigma_v_eff = 0.0

        if sigma_v_eff <= 0:
            return {
                "CN": 1.0,
                "m": 0.784,
                "N60": N,
                "N1_60": N,
                "delta_N1_60": 0.0,
                "N1_60cs": max(N, 0.0),
                "iterations": 0
            }

        # Energy correction (CE normalized to 0.60)
        N60 = N * (self.CE / 0.60)

        fc_term = FC + 0.01
        try:
            delta_N1 = float(np.exp(1.63 + 9.7 / fc_term - (15.7 / fc_term) ** 2))
            if np.isnan(delta_N1) or np.isinf(delta_N1):
                delta_N1 = 0.0
        except Exception:
            delta_N1 = 0.0

        CN = 1.0
        m = 0.784
        N1_60 = N60 * CN
        N1_60cs = N1_60 + delta_N1

        max_iter = 25
        tol = 0.001

        for it in range(1, max_iter + 1):
            # Update CN from current (N1)60cs
            try:
                m = float(0.784 - 0.0768 * np.sqrt(max(N1_60cs, 0.0)))
            except Exception:
                m = 0.784

            try:
                CN_new = float((Pa / sigma_v_eff) ** m)
            except Exception:
                CN_new = 1.0
            CN_new = float(min(CN_new, 1.7))

            # Check convergence on CN (per blueprint)
            if abs(CN_new - CN) <= tol:
                CN = CN_new
                break

            CN = CN_new
            N1_60 = N60 * CN
            N1_60cs = N1_60 + delta_N1

        # Guardrails (engineering spreadsheet convention)
        if N1_60cs < 0:
            N1_60cs = 0.0
        if N1_60cs > 46:
            N1_60cs = 46.0

        return {
            "CN": float(CN),
            "m": float(m),
            "N60": float(N60),
            "N1_60": float(N1_60),
            "delta_N1_60": float(delta_N1),
            "N1_60cs": float(N1_60cs),
            "iterations": int(it if 'it' in locals() else 0)
        }

    def analyze_layer(self, depth, N_measured, sigma_v_total, sigma_v_eff, FC, PI=None):
        """Single-layer analysis"""
        # Input validation
        depth = float(depth)
        N_measured = float(N_measured)
        sigma_v_total = float(sigma_v_total)
        sigma_v_eff = float(sigma_v_eff)
        FC = float(FC)

        # Step 0: Clay-like gatekeeper (simplified PI-only rule: PI >= 7 => non-liquefiable)
        if self._is_clay_like(PI):
            return {
                "Depth": round(depth, 2),
                "N_val": round(N_measured, 1),
                "FC": round(FC, 1),
                "PI": float(PI) if PI is not None else None,
                "ClayLike": True,
                "NonLiquefiable": True,
                "CSR": 0.0,
                "CRR_7.5": 0.0,
                "MSF_max": 0.0,
                "MSF": 0.0,
                "C_sigma": 0.0,
                "K_sigma": 0.0,
                "CRR": 0.0,
                "FS": 99.0,
                "Liquefy": "No (PI≥7)",
                "Method": "I&B 2014"
            }
        
        # Validate input
        if np.isnan(depth) or np.isinf(depth) or depth < 0:
            return {"Depth": depth, "FS": 99.0, "Liquefy": "No", "Error": "Invalid depth"}
        if np.isnan(N_measured) or np.isinf(N_measured) or N_measured < 0:
            N_measured = 0.0
        if np.isnan(FC) or np.isinf(FC) or FC < 0:
            FC = 0.0
        
        if sigma_v_eff <= 0:  # Avoid error for surface layer with no stress
            return {
                "Depth": depth, 
                "N_val": N_measured,
                "FC": FC,
                "CSR": 0.0,
                "CRR": 0.0,
                "FS": 99.0, 
                "Liquefy": "No"
            }

        try:
            rd = self.calculate_rd(depth)
            
            # Calculate CSR
            if sigma_v_eff > 0:
                CSR = 0.65 * (sigma_v_total / sigma_v_eff) * self.PGA * rd
            else:
                CSR = 0.0
            
            # Validate CSR
            if np.isnan(CSR) or np.isinf(CSR):
                CSR = 0.0
            
            corr = self.solve_N1_60cs(N_measured, sigma_v_eff, FC)
            N1_60cs = float(corr.get("N1_60cs", 0.0))

            # Step 4: scaling factors (I&B 2014 blueprint)
            # MSFmax = 1.09 + ((N1)60cs/31.5)^2 <= 2.2
            MSF_max = 1.09 + (N1_60cs / 31.5) ** 2
            MSF_max = float(min(MSF_max, 2.2))
            MSF = 1.0 + (MSF_max - 1.0) * (8.64 * float(np.exp(-self.Mw / 4.0)) - 1.325)

            # K_sigma = 1 - C_sigma ln(sigma'v/Pa) <= 1.1
            C_sigma = 0.0
            try:
                C_sigma = 1.0 / (18.9 - 2.55 * np.sqrt(max(N1_60cs, 0.0)))
            except Exception:
                C_sigma = 0.0
            C_sigma = float(min(C_sigma, 0.3))

            if sigma_v_eff > 0:
                try:
                    K_sigma = 1.0 - C_sigma * float(np.log(sigma_v_eff / self.Pa))
                except Exception:
                    K_sigma = 1.0
            else:
                K_sigma = 1.0
            K_sigma = float(min(K_sigma, 1.1))

            # Step 3: CRR_7.5 (I&B 2014)
            if N1_60cs >= 37.5:
                CRR_75 = 2.0
            else:
                try:
                    term1 = N1_60cs / 14.1
                    term2 = (N1_60cs / 126)**2
                    term3 = (N1_60cs / 23.6)**3
                    term4 = (N1_60cs / 25.4)**4
                    CRR_75 = np.exp(term1 + term2 - term3 + term4 - 2.8)
                    
                    # Validate result
                    if np.isnan(CRR_75) or np.isinf(CRR_75):
                        CRR_75 = 0.0
                except (ValueError, OverflowError):
                    CRR_75 = 0.0
                
            CRR_field = float(CRR_75) * float(MSF) * float(K_sigma)
            
            # Handle very small CSR
            if CSR < 1e-4: 
                FS = 10.0 
            else:
                FS = CRR_field / CSR
            
            # Validate FS
            if np.isnan(FS) or np.isinf(FS):
                FS = 10.0
            
            return {
                "Depth": round(depth, 2),
                "N_val": round(N_measured, 1),
                "FC": round(FC, 1),
                "PI": float(PI) if PI is not None else None,
                "ClayLike": False,
                "NonLiquefiable": False,
                "rd": float(rd),
                "CN": float(corr.get("CN", 1.0)),
                "m": float(corr.get("m", 0.0)),
                "N60": float(corr.get("N60", 0.0)),
                "N1_60": float(corr.get("N1_60", 0.0)),
                "delta_N1_60": float(corr.get("delta_N1_60", 0.0)),
                "N1_60cs": float(N1_60cs),
                "CN_iter": int(corr.get("iterations", 0)),
                "CSR": round(CSR, 4),
                "CRR_7.5": float(CRR_75),
                "MSF_max": float(MSF_max),
                "MSF": float(MSF),
                "C_sigma": float(C_sigma),
                "K_sigma": float(K_sigma),
                "CRR": round(CRR_field, 4),
                "FS": round(min(FS, 5.0), 2),  # Cap display at 5.0
                "Liquefy": "Yes" if FS < 1.0 else "No",
                "Method": "I&B 2014"
            }
        except Exception as e:
            # On error, return safe value
            return {
                "Depth": round(depth, 2),
                "N_val": round(N_measured, 1),
                "FC": round(FC, 1),
                "CSR": 0.0,
                "CRR": 0.0,
                "FS": 99.0,
                "Liquefy": "No",
                "Error": str(e),
                "Method": "I&B 2014"
            }

# ==========================================
# Core algorithm B: NCEER (Youd et al., 2001)
# ==========================================
class NCEER2001:
    def __init__(self, Mw, PGA, Pa=100.0, CE=0.60):
        self.Mw = float(Mw)
        self.PGA = float(PGA)
        self.Pa = Pa
        self.CE = float(CE)  # Energy Ratio (default 0.60 = 60%)

    def _is_clay_like(self, PI):
        try:
            if PI is None:
                return False
            PI = float(PI)
        except Exception:
            return False
        return PI >= 7.0

    def calc_rd(self, depth):
        """Liao and Whitman (1986) - NCEER method"""
        z = float(depth)
        if np.isnan(z) or np.isinf(z) or z < 0:
            return 1.0
        
        try:
            if z <= 9.15:
                rd = 1.0 - 0.00765 * z
            elif z <= 23.0:
                rd = 1.174 - 0.0267 * z
            else:
                rd = 0.5  # lower bound
            return min(max(rd, 0.0), 1.0)
        except (ValueError, OverflowError):
            return 1.0

    def calc_MSF(self):
        """Magnitude Scaling Factor for NCEER (Youd et al. 2001 suggested)
        
        Note: For large earthquakes (Mw > 7.5), MSF should be < 1.0.
        The previous implementation incorrectly forced MSF >= 1.0, which would
        overestimate soil resistance for large earthquakes (non-conservative).
        """
        try:
            # MSF = 10^2.24 / Mw^2.56, cap at 1.5 (per user blueprint)
            MSF = (10.0 ** 2.24) / (float(self.Mw) ** 2.56)
            return min(float(MSF), 1.5)
        except (ValueError, OverflowError):
            return 1.0

    def solve_N1_60cs(self, N_measured, sigma_v_eff, FC):
        """Calculate (N1)60cs for NCEER method (Youd et al., 2001)"""
        Pa = self.Pa
        N_val = float(N_measured)
        FC = float(FC)
        
        if sigma_v_eff <= 0:
            return 1.0
        if np.isnan(N_val) or np.isinf(N_val) or N_val < 0:
            return 1.0
        if np.isnan(FC) or np.isinf(FC) or FC < 0:
            FC = 0.0
        
        try:
            # CN Calculation
            CN = (Pa / sigma_v_eff) ** 0.5
            CN = min(CN, 1.7)
            
            # Hammer Energy Correction: N60 = N × (CE / 0.60)
            # Standard energy ratio is 0.60 (60%), so we normalize to standard
            N60 = N_val * (self.CE / 0.60)
            N1_60 = N60 * CN
            
            # Fines Content Correction
            if FC <= 5:
                alpha, beta = 0, 1.0
            elif FC <= 35:
                alpha = np.exp(1.76 - (190 / (FC**2 + 1e-9)))
                beta = 0.99 + (FC**1.5 / 1000)
            else:
                alpha = 5.0
                beta = 1.2
            
            N1_60cs = alpha + beta * N1_60
            
            if np.isnan(N1_60cs) or np.isinf(N1_60cs):
                return float(N_val)
            
            return float(N1_60cs)
        except (ValueError, OverflowError, ZeroDivisionError):
            return float(N_val)

    def analyze_layer(self, depth, N_measured, sigma_v_total, sigma_v_eff, FC, PI=None):
        """Single layer analysis using NCEER method"""
        depth = float(depth)
        N_measured = float(N_measured)
        sigma_v_total = float(sigma_v_total)
        sigma_v_eff = float(sigma_v_eff)
        FC = float(FC)

        # Step 0: Clay-like gatekeeper (simplified PI-only rule)
        if self._is_clay_like(PI):
            return {
                "Depth": round(depth, 2),
                "N_val": round(N_measured, 1),
                "FC": round(FC, 1),
                "PI": float(PI) if PI is not None else None,
                "ClayLike": True,
                "NonLiquefiable": True,
                "CSR": 0.0,
                "CRR_7.5": 0.0,
                "MSF": 0.0,
                "K_sigma": 0.0,
                "CRR": 0.0,
                "FS": 99.0,
                "Liquefy": "No (PI≥7)",
                "Method": "NCEER 2001"
            }
        
        if np.isnan(depth) or np.isinf(depth) or depth < 0:
            return {"Depth": depth, "FS": 99.0, "Liquefy": "No", "Error": "Invalid depth", "Method": "NCEER 2001"}
        if np.isnan(N_measured) or np.isinf(N_measured) or N_measured < 0:
            N_measured = 0.0
        if np.isnan(FC) or np.isinf(FC) or FC < 0:
            FC = 0.0
        
        if sigma_v_eff <= 0:
            return {
                "Depth": depth,
                "N_val": N_measured,
                "FC": FC,
                "CSR": 0.0,
                "CRR": 0.0,
                "FS": 99.0,
                "Liquefy": "No",
                "Method": "NCEER 2001"
            }
        
        try:
            rd = self.calc_rd(depth)
            
            # Calculate CSR
            if sigma_v_eff > 0:
                CSR = 0.65 * (sigma_v_total / sigma_v_eff) * self.PGA * rd
            else:
                CSR = 0.0
            
            if np.isnan(CSR) or np.isinf(CSR):
                CSR = 0.0
            
            # SPT correction pieces (audit-friendly)
            Pa = float(self.Pa)
            CN = float(min((Pa / sigma_v_eff) ** 0.5, 1.7))
            N60 = float(N_measured) * (self.CE / 0.60)
            N1_60 = float(N60 * CN)

            # Fines correction α/β (Youd et al., 2001)
            if FC <= 5:
                alpha, beta = 0.0, 1.0
            elif FC < 35:
                alpha = float(np.exp(1.76 - (190.0 / (FC ** 2 + 1e-9))))
                beta = float(0.99 + (FC ** 1.5 / 1000.0))
            else:
                alpha, beta = 5.0, 1.2

            N1_60cs = float(alpha + beta * N1_60)
            
            # MSF
            MSF = self.calc_MSF()
            if np.isnan(MSF) or np.isinf(MSF):
                MSF = 1.0
            
            # CRR calculation
            if N1_60cs >= 30:
                CRR_75 = 2.0
            else:
                try:
                    a = 1.0 / (34 - N1_60cs + 0.01)
                    b = N1_60cs / 135
                    c = 50 / ((10 * N1_60cs + 45)**2 + 0.01)
                    d = 1.0 / 200
                    CRR_75 = a + b + c - d
                    
                    if np.isnan(CRR_75) or np.isinf(CRR_75) or CRR_75 < 0:
                        CRR_75 = 0.0
                except (ValueError, OverflowError, ZeroDivisionError):
                    CRR_75 = 0.0
            
            # K_sigma (Overburden Correction Factor) - Corrected Implementation
            # According to NCEER 2001 (Hynes and Olsen, 1999), the exponent f is related to
            # relative density (Dr), NOT depth. Using depth incorrectly distorts the physics.
            K_sigma = 1.0
            Dr_est = None
            f = None
            if sigma_v_eff > self.Pa:  # Only apply correction when effective stress > 1 atm (~100 kPa)
                # Step 1: Estimate relative density Dr from N1_60cs (Meyerhof approximation)
                # Dr ≈ sqrt(N1_60cs / 46) * 100 (in percentage)
                try:
                    Dr_est = (N1_60cs / 46.0) ** 0.5 * 100.0
                    Dr_est = min(max(Dr_est, 0.0), 100.0)  # Limit to 0-100%
                    
                    # Step 2: Calculate exponent f using relative density (Hynes and Olsen, 1999)
                    # f = 1 - 0.005 * Dr (where Dr is in percentage)
                    f = 1.0 - 0.005 * Dr_est
                    # NCEER suggests f should be in reasonable range (typically 0.6 <= f <= 0.8)
                    f = min(max(f, 0.6), 0.8)
                    
                    # Step 3: Calculate K_sigma
                    K_sigma = (sigma_v_eff / self.Pa) ** (f - 1.0)
                    # K_sigma should not exceed 1.0 (formula naturally gives < 1.0 when sigma > Pa)
                    K_sigma = min(K_sigma, 1.0)
                    
                    if np.isnan(K_sigma) or np.isinf(K_sigma) or K_sigma < 0:
                        K_sigma = 1.0
                except (ValueError, OverflowError, ZeroDivisionError):
                    K_sigma = 1.0
            
            CRR_field = CRR_75 * MSF * K_sigma
            
            # FS calculation
            if CSR < 1e-4:
                FS = 10.0
            else:
                FS = CRR_field / CSR
            
            if np.isnan(FS) or np.isinf(FS):
                FS = 10.0
            
            return {
                "Depth": round(depth, 2),
                "N_val": round(N_measured, 1),
                "FC": round(FC, 1),
                "PI": float(PI) if PI is not None else None,
                "ClayLike": False,
                "NonLiquefiable": False,
                "rd": float(rd),
                "CN": float(CN),
                "N60": float(N60),
                "N1_60": float(N1_60),
                "alpha": float(alpha),
                "beta": float(beta),
                "N1_60cs": float(N1_60cs),
                "CSR": round(CSR, 4),
                "CRR_7.5": float(CRR_75),
                "MSF": float(MSF),
                "Dr_est": float(Dr_est) if Dr_est is not None else None,
                "f": float(f) if f is not None else None,
                "K_sigma": float(K_sigma),
                "CRR": round(CRR_field, 4),
                "FS": round(min(FS, 5.0), 2),
                "Liquefy": "Yes" if FS < 1.0 else "No",
                "Method": "NCEER 2001"
            }
        except Exception as e:
            return {
                "Depth": round(depth, 2),
                "N_val": round(N_measured, 1),
                "FC": round(FC, 1),
                "CSR": 0.0,
                "CRR": 0.0,
                "FS": 99.0,
                "Liquefy": "No",
                "Error": str(e),
                "Method": "NCEER 2001"
            }

# ==========================================
# Stress calculator (borehole data)
# ==========================================
def calculate_stress_profile(df, GWT):
    """
    Compute in-situ stress from borehole layers.
    df: DataFrame with 'depth', 'gamma' (unit weight)
    GWT: Groundwater table depth (m)
    """
    sigma_v_list = []  # Total stress
    sigma_ve_list = []  # Effective stress
    
    current_sigma_v = 0.0
    prev_depth = 0.0
    gamma_w = 9.81  # Unit weight of water
    
    # Ensure data sorted by depth
    if 'depth' in df.columns:
        df = df.sort_values(by='depth').reset_index(drop=True)
    
    for index, row in df.iterrows():
        depth = float(row['depth'])
        gamma = float(row['gamma'])
        
        # Layer thickness
        thickness = depth - prev_depth
        
        # Accumulate total stress
        current_sigma_v += thickness * gamma
        
        # Pore pressure (u)
        if depth > GWT:
            if prev_depth >= GWT:
                u = (depth - GWT) * gamma_w
            else:
                u = (depth - GWT) * gamma_w
        else:
            u = 0.0
            
        sigma_ve = current_sigma_v - u
        
        # Avoid effective stress <= 0 (division error)
        if sigma_ve <= 0.1: 
            sigma_ve = 0.1
        
        sigma_v_list.append(current_sigma_v)
        sigma_ve_list.append(sigma_ve)
        
        prev_depth = depth
        
    df['sigma_v'] = sigma_v_list
    df['sigma_ve'] = sigma_ve_list
    return df

# ==========================================
# Plotting (generate analysis plots)
# ==========================================
def plot_liquefaction_analysis(df, project_name="Liquefaction Analysis", method="I&B 2014", unit_system='imperial'):
    """
    Generate US-standard 3-panel plot for liquefaction analysis
    Left: Soil Profile (N_meas vs (N1)60cs)
    Middle: Triggering Analysis (CSR vs CRR)
    Right: Factor of Safety (FS)
    
    Returns: BytesIO object for web display
    unit_system: 'imperial'  'metric'
    """
    _, plt = _lazy_mpl_pyplot()
    # Configure matplotlib to use proper font for math symbols
    plt.rcParams['mathtext.default'] = 'regular'
    
    # Get unit labels
    unit_labels = get_unit_labels(unit_system)
    
    # Chart size: width 6.43", maintain 14:9 aspect ratio
    fig_width = 11  # inches
    fig_height = 11 * 9 / 14  # 14:9 aspect ratio
    fig, axes = plt.subplots(1, 3, figsize=(fig_width, fig_height), sharey=True)
    
    depths = df['depth']
    
    # ===== Panel 1: Soil Profile =====
    # Left Panel: Show measured N-value and corrected (N1)60cs
    if 'spt_n' in df.columns:
        axes[0].plot(df['spt_n'], depths, 'o-', label='$N_{meas}$', color='gray', 
                     markersize=5, linewidth=1.5, markeredgecolor='black', markeredgewidth=0.5)
    if 'N1_60cs' in df.columns:
        axes[0].plot(df['N1_60cs'], depths, 's-', label='$(N_1)_{60cs}$', color='blue', 
                     markersize=5, linewidth=1.5, markeredgecolor='black', markeredgewidth=0.5)
    
    axes[0].set_xlabel('SPT N-Value', fontsize=11, fontweight='bold')
    axes[0].set_ylabel(unit_labels['depth_label'], fontsize=11, fontweight='bold')
    axes[0].set_title('Soil Profile', fontsize=12, fontweight='bold', pad=10)
    axes[0].invert_yaxis()
    axes[0].grid(True, linestyle='--', alpha=0.5, linewidth=0.8)
    axes[0].legend(loc='lower right', fontsize=9, framealpha=0.9)
    axes[0].set_xlim(left=0)

    # ===== Panel 2: Triggering Analysis (Load vs Resistance) =====
    # Middle Panel: CSR (solid line) vs CRR (dashed line)
    if 'CSR' in df.columns and 'CRR' in df.columns:
        # CSR line (Load - solid black line)
        axes[1].plot(df['CSR'], depths, 'k-', label='CSR (Load)', linewidth=2.5)
        # CRR line (Resistance - dashed green line)
        axes[1].plot(df['CRR'], depths, 'g--', label='CRR (Resistance)', linewidth=2.5)
        
        # Fill liquefiable zones (where CSR > CRR) with red shading
        axes[1].fill_betweenx(depths, df['CSR'], df['CRR'], 
                              where=(df['CSR'] > df['CRR']), 
                              color='red', alpha=0.4, label='Liquefiable Zone')
    
    axes[1].set_xlabel('Cyclic Stress Ratio', fontsize=11, fontweight='bold')
    axes[1].set_ylabel(unit_labels['depth_label'], fontsize=11, fontweight='bold')
    axes[1].set_title('Triggering Analysis\n(Load vs Resistance)', fontsize=12, fontweight='bold', pad=10)
    axes[1].invert_yaxis()
    axes[1].grid(True, linestyle='--', alpha=0.5, linewidth=0.8)
    axes[1].legend(loc='lower right', fontsize=9, framealpha=0.9)
    axes[1].set_xlim(left=0)

    # ===== Panel 3: Factor of Safety =====
    # Right Panel: FS with red vertical line at FS=1.0 and red shading for FS<1.0
    if 'FS' in df.columns:
        # Plot FS line
        axes[2].plot(df['FS'], depths, 'b-o', markersize=5, linewidth=1.5, 
                    label='Factor of Safety', markeredgecolor='black', markeredgewidth=0.5)
        
        # Prominent red vertical line at FS = 1.0
        axes[2].axvline(x=1.0, color='red', linestyle='-', linewidth=3, 
                       alpha=0.8, label='FS = 1.0 Limit', zorder=10)
        
        # Red shading for FS < 1.0 (liquefiable zones)
        axes[2].fill_betweenx(depths, 0, df['FS'], 
                             where=(df['FS'] < 1.0), 
                             color='red', alpha=0.4, label='Liquefiable (FS < 1.0)')
    
    axes[2].set_xlabel('Factor of Safety (FS)', fontsize=11, fontweight='bold')
    axes[2].set_ylabel(unit_labels['depth_label'], fontsize=11, fontweight='bold')
    axes[2].set_title('Factor of Safety', fontsize=12, fontweight='bold', pad=10)
    axes[2].invert_yaxis()
    axes[2].set_xlim(0, max(2.0, df['FS'].max() * 1.1) if 'FS' in df.columns else 2.0)
    axes[2].grid(True, linestyle='--', alpha=0.5, linewidth=0.8)
    axes[2].legend(loc='lower right', fontsize=9, framealpha=0.9)

    # Set overall title with method name
    method_display = "Idriss & Boulanger (2014)" if "I&B" in method or "2014" in method else "NCEER (Youd et al., 2001)"
    plt.suptitle(f"{project_name} - {method_display}", fontsize=14, fontweight='bold', y=0.98)
    plt.tight_layout(rect=[0, 0, 1, 0.96])  # Leave space for suptitle
    
    # Save to BytesIO
    img_bytes = io.BytesIO()
    plt.savefig(img_bytes, format='png', dpi=150, bbox_inches='tight', facecolor='white')
    img_bytes.seek(0)
    plt.close()
    
    return img_bytes


def plot_cpt_liquefaction_results(df, total_settlement_m=0.0, project_name="CPT Liquefaction Analysis", unit_system='metric'):
    """
    Borehole-log style CPT liquefaction summary plot (4 panels):
      1) Ic (soil type)
      2) CSR vs CRR_7.5 (triggering)
      3) FS (with FS=1 line and liquefiable shading)
      4) Cumulative settlement

    Expected df columns: depth, Ic, CSR, CRR_7.5, FS, Settlement_m, Soil_Type (optional)
    Depth is assumed in meters inside df.
    """
    _, plt = _lazy_mpl_pyplot()
    plt.rcParams['mathtext.default'] = 'regular'

    unit_system = (unit_system or 'metric').lower()
    depth_m = pd.to_numeric(df.get('depth'), errors='coerce')
    depth_m = depth_m.fillna(0.0)

    if unit_system == 'imperial':
        depth = depth_m * 3.28084
        depth_label = 'Depth (ft)'
        cum_settlement = pd.to_numeric(df.get('Settlement_m'), errors='coerce').fillna(0.0).cumsum() * 39.3701  # inches
        cum_settlement_label = 'Cum. Settlement (in)'
        total_settlement_label = f"Total: {float(total_settlement_m) * 39.3701:.1f} in"
    else:
        depth = depth_m
        depth_label = 'Depth (m)'
        cum_settlement = pd.to_numeric(df.get('Settlement_m'), errors='coerce').fillna(0.0).cumsum() * 100.0  # cm
        cum_settlement_label = 'Cum. Settlement (cm)'
        total_settlement_label = f"Total: {float(total_settlement_m) * 100.0:.1f} cm"

    fig, axes = plt.subplots(1, 4, figsize=(15, 8), sharey=True)

    # --- Panel 1: Ic (Soil Type by Ic ranges) ---
    ax = axes[0]
    Ic = pd.to_numeric(df.get('Ic'), errors='coerce')

    # Robertson-style Ic bands (typical interpretation)
    # These thresholds are commonly used for quick SBT grouping in liquefaction reporting.
    ic_bands = [
        (0.0, 1.31, 'Gravelly Sand / Dense Sand', '#E3F2FD'),
        (1.31, 2.05, 'Sand to Silty Sand', '#E8F5E9'),
        (2.05, 2.60, 'Silty Sand to Sandy Silt', '#FFFDE7'),
        (2.60, 2.95, 'Clayey Silt / Silty Clay', '#FBE9E7'),
        (2.95, 4.0, 'Clay', '#F3E5F5'),
    ]
    for x0, x1, label, color in ic_bands:
        ax.axvspan(x0, x1, color=color, alpha=0.55, zorder=0)
        # place label near top
        try:
            ax.text((x0 + x1) / 2.0, float(depth.min()), label, ha='center', va='top', fontsize=8, color='#333',
                    rotation=90, alpha=0.9)
        except Exception:
            pass

    ax.plot(Ic, depth, 'k-', linewidth=1.5, label='$I_c$')
    ax.axvline(x=2.6, color='gray', linestyle='--', linewidth=1)
    try:
        ax.fill_betweenx(depth, Ic, 2.6, where=(Ic > 2.6), color='lightgray', alpha=0.5, label='Clay-like (Non-liq)')
    except Exception:
        pass
    ax.set_xlabel('SBT Index ($I_c$)')
    ax.set_ylabel(depth_label)
    ax.set_title('Soil Type')
    ax.grid(True, linestyle=':', alpha=0.6)
    ax.invert_yaxis()
    ax.set_xlim(0.0, 4.0)

    # --- Panel 2: CSR vs CRR ---
    ax = axes[1]
    CSR = pd.to_numeric(df.get('CSR'), errors='coerce')
    CRR = pd.to_numeric(df.get('CRR_7.5'), errors='coerce')
    ax.plot(CSR, depth, 'r-', linewidth=1.5, label='CSR (Demand)')
    ax.plot(CRR, depth, 'b--', linewidth=1.5, label='CRR (Capacity)')
    try:
        ax.fill_betweenx(depth, CSR, CRR, where=(CSR > CRR), color='red', alpha=0.3, label='Liquefaction')
    except Exception:
        pass
    ax.set_xlabel('CSR & CRR')
    ax.set_title('Triggering Analysis')
    ax.grid(True, linestyle=':', alpha=0.6)
    ax.legend(loc='lower right', fontsize='small')

    # --- Panel 3: FS ---
    ax = axes[2]
    FS = pd.to_numeric(df.get('FS'), errors='coerce')
    fs_plot = FS.clip(upper=2.0)
    ax.plot(fs_plot, depth, 'g-', linewidth=2)
    ax.axvline(x=1.0, color='red', linestyle='-', linewidth=2)
    try:
        ax.fill_betweenx(depth, fs_plot, 1.0, where=(fs_plot < 1.0), color='red', alpha=0.5)
    except Exception:
        pass
    ax.set_xlabel('Factor of Safety ($FS_L$)')
    ax.set_title('Safety Factor')
    ax.set_xlim(0, 2.0)
    ax.grid(True, linestyle=':', alpha=0.6)

    # --- Panel 4: cumulative settlement ---
    ax = axes[3]
    ax.plot(cum_settlement, depth, 'b-', linewidth=1.5)
    try:
        ax.fill_betweenx(depth, 0, cum_settlement, color='blue', alpha=0.2)
    except Exception:
        pass
    ax.set_xlabel(cum_settlement_label)
    ax.set_title(f"Settlement\n{total_settlement_label}")
    ax.grid(True, linestyle=':', alpha=0.6)

    plt.suptitle(project_name, fontsize=14, fontweight='bold', y=0.98)
    plt.tight_layout(rect=[0, 0, 1, 0.96])

    img_bytes = io.BytesIO()
    plt.savefig(img_bytes, format='png', dpi=150, bbox_inches='tight', facecolor='white')
    img_bytes.seek(0)
    plt.close()
    return img_bytes

# ==========================================
# Excel 
# ==========================================
def _write_formula_with_subscript(worksheet, row, col, formula_text, normal_fmt, subscript_fmt):
    """
    
     write_rich_string 
    """
    import re
    
    # ，
    if not formula_text or formula_text.strip() == "":
        worksheet.write(row, col, formula_text, normal_fmt)
        return
    
    #  LaTeX （$ ），，
    # 
    if '$' in formula_text:
        worksheet.write(row, col, formula_text, normal_fmt)
        return
    
    text = formula_text
    rich_parts = []
    i = 0
    
    # 
    # ：(, ) - ：，
    patterns = [
        # (N1)60cs - ， (N1)60 
        (r'\(N(\d+)\)(\d+)cs', lambda m: [
            (normal_fmt, '('), (normal_fmt, 'N'), (subscript_fmt, m.group(1)),
            (normal_fmt, ')'), (subscript_fmt, m.group(2)), (normal_fmt, 'cs')
        ]),
        # (N1)60 -  (N1)60  cs
        (r'\(N(\d+)\)(\d+)(?!cs)', lambda m: [
            (normal_fmt, '('), (normal_fmt, 'N'), (subscript_fmt, m.group(1)),
            (normal_fmt, ')'), (subscript_fmt, m.group(2))
        ]),
        # (N1) （）
        (r'\(N(\d+)\)(?!\d)', lambda m: [
            (normal_fmt, '('), (normal_fmt, 'N'), (subscript_fmt, m.group(1)), (normal_fmt, ')')
        ]),
        # σv  σ'v
        (r"σ('?)v", lambda m: [
            (normal_fmt, 'σ' + m.group(1)), (subscript_fmt, 'v')
        ]),
        # Pa
        (r'P([a])', lambda m: [
            (normal_fmt, 'P'), (subscript_fmt, m.group(1))
        ]),
        # Mw
        (r'M([w])', lambda m: [
            (normal_fmt, 'M'), (subscript_fmt, m.group(1))
        ]),
        # CRR7.5
        (r'CRR([\d.]+)', lambda m: [
            (normal_fmt, 'CRR'), (subscript_fmt, m.group(1))
        ]),
    ]
    
    # ，
    matches = []
    processed_positions = set()  # ，
    
    for pattern, handler in patterns:
        try:
            for match in re.finditer(pattern, text):
                start, end = match.span()
                # 
                overlap = False
                for proc_start, proc_end in processed_positions:
                    if not (end <= proc_start or start >= proc_end):
                        overlap = True
                        break
                if not overlap:
                    matches.append((start, end, handler(match)))
                    processed_positions.add((start, end))
        except re.error as e:
            # ，
            print(f"Regex error for pattern {pattern}: {e}")
            continue
        except Exception as e:
            # 
            print(f"Error processing pattern {pattern}: {e}")
            continue
    
    # （）
    matches.sort(key=lambda x: x[0], reverse=True)
    
    # 
    result_parts = []
    last_pos = len(text)
    
    for start, end, parts in matches:
        # 
        if end < last_pos:
            result_parts.insert(0, (normal_fmt, text[end:last_pos]))
        # （）
        result_parts = parts + result_parts
        last_pos = start
    
    # 
    if last_pos > 0:
        result_parts.insert(0, (normal_fmt, text[:last_pos]))
    
    # 
    merged_parts = []
    if result_parts:
        current_fmt = result_parts[0][0]
        current_text = result_parts[0][1]
        for fmt, txt in result_parts[1:]:
            if fmt is current_fmt:
                current_text += txt
            else:
                merged_parts.extend([current_fmt, current_text])
                current_fmt = fmt
                current_text = txt
        merged_parts.extend([current_fmt, current_text])
    
    # 
    if len(merged_parts) > 2:  # 
        try:
            #  merged_parts 
            #  LaTeX （ $ ），
            if '$' in formula_text:
                #  LaTeX ，
                worksheet.write(row, col, formula_text, normal_fmt)
            else:
                #  merged_parts ：（）
                # 
                if len(merged_parts) % 2 != 0 or len(merged_parts) == 0:
                    # ，，
                    worksheet.write(row, col, formula_text, normal_fmt)
                else:
                    # 
                    if not hasattr(merged_parts[0], 'xf_index'):
                        # ，
                        worksheet.write(row, col, formula_text, normal_fmt)
                    else:
                        worksheet.write_rich_string(row, col, *merged_parts)
        except Exception as e:
            # ，
            print(f"Rich string write failed for text '{formula_text[:50]}...', falling back to plain text: {e}")
            worksheet.write(row, col, formula_text, normal_fmt)
    else:
        # ，
        worksheet.write(row, col, formula_text, normal_fmt)

def generate_us_style_excel(df, metadata, plot_image_bytes=None, unit_system='imperial'):
    """
     (Idriss & Boulanger 2014)  Excel 
     CATii：，，
    unit_system: 'imperial'  'metric'
    """
    
    # 
    unit_labels = get_unit_labels(unit_system)
    
    # --- 1.  ---
    output_columns = [
        'depth', 'soil_class', 'spt_n', 'fc', 'gamma', # 
        'sigma_v', 'sigma_ve',                         # 
        'rd', 'CSR',                                   # 
        'N1_60cs', 'CRR',                              # 
        'FS', 'Liquefy'                                # 
    ]
    
    # 
    for col in output_columns:
        if col not in df.columns:
            df[col] = '' if col == 'soil_class' else 0

    # （）
    column_mapping = {
        'depth': unit_labels['depth'],
        'soil_class': 'Soil\nType',
        'spt_n': 'SPT N\n(meas)',
        'fc': 'Fines\n(%)',
        'gamma': unit_labels['gamma'],
        'sigma_v': unit_labels['sigma_v'],
        'sigma_ve': unit_labels['sigma_ve'],
        'rd': 'rd',
        'CSR': 'CSR\n(Load)',
        'N1_60cs': '(N1)60cs',
        'CRR': 'CRR\n(Resist)',
        'FS': 'FS',
        'Liquefy': 'Liquefaction\nPotential'
    }
    
    #  DF
    export_df = df[output_columns].copy()
    export_df.rename(columns=column_mapping, inplace=True)

    # --- 2.  Excel ---
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
        sheet_name = 'Analysis Report'
        workbook = writer.book
        
        #  ()
        IMG_START_ROW = 1
        IMG_END_ROW = 18  # ，
        INFO_START_ROW = 25  # Project Parameters  5 （ 20）
        TABLE_HEADER_ROW = 29  #  5 （ 24）
        DATA_START_ROW = 30  #  5 （ 25）
        
        #  (，)
        export_df.to_excel(writer, sheet_name=sheet_name, startrow=TABLE_HEADER_ROW, index=False)
        worksheet = writer.sheets[sheet_name]
        
        # --- 3.  (Styles) ---
        #  ()
        header_fmt = workbook.add_format({
            'bold': True, 'text_wrap': True, 'valign': 'vcenter', 'align': 'center',
            'fg_color': '#D3D3D3', 'font_color': 'black', 'border': 1
        })
        
        #  (, )
        center_fmt = workbook.add_format({'align': 'center', 'valign': 'vcenter', 'border': 1})
        float_fmt_2 = workbook.add_format({'num_format': '0.00', 'align': 'center', 'valign': 'vcenter', 'border': 1})
        float_fmt_3 = workbook.add_format({'num_format': '0.000', 'align': 'center', 'valign': 'vcenter', 'border': 1})
        
        # （）
        label_fmt = workbook.add_format({
            'bold': True, 'align': 'right', 'font_size': 11,
            'bg_color': 'white', 'border': 1, 'border_color': 'white'
        })
        value_fmt = workbook.add_format({
            'align': 'left', 'font_size': 11,
            'bg_color': 'white', 'border': 1, 'border_color': 'white'
        })
        title_fmt = workbook.add_format({
            'bold': True, 'font_size': 16,
            'bg_color': 'white', 'border': 1, 'border_color': 'white'
        })
        subtitle_fmt = workbook.add_format({
            'bold': True, 'font_size': 12, 'underline': True,
            'bg_color': 'white', 'border': 1, 'border_color': 'white'
        })
        
        #  ()
        red_bg_fmt = workbook.add_format({'bg_color': '#FFC7CE', 'font_color': '#9C0006', 'border': 1, 'align': 'center'})
        
        # （，）
        formula_box_fmt = workbook.add_format({
            'bg_color': 'white', 'border': 1, 'border_color': 'white',
            'valign': 'top', 'text_wrap': False, 'font_size': 9
        })
        formula_title_fmt = workbook.add_format({
            'bg_color': 'white', 'border': 1, 'border_color': 'white',
            'font_color': 'black', 'bold': True, 'align': 'left', 'font_size': 12,
            'text_wrap': False, 'valign': 'top'
        })
        # （）
        formula_subscript_fmt = workbook.add_format({
            'bg_color': 'white', 'border': 1, 'border_color': 'white',
            'font_script': 2, 'font_size': 9  # font_script: 2 = subscript
        })

        # --- 4.  (Top Section) ---
        if plot_image_bytes:
            try:
                # xlsxwriter  insert_image  BytesIO ， bytes
                if isinstance(plot_image_bytes, bytes):
                    plot_image_bytes = io.BytesIO(plot_image_bytes)
                elif not hasattr(plot_image_bytes, 'seek'):
                    plot_image_bytes = io.BytesIO(plot_image_bytes)
                plot_image_bytes.seek(0)
                # （ Excel ）
                if plot_image_bytes.getbuffer().nbytes < 100:
                    raise ValueError("Image too small or empty")
                worksheet.insert_image('A2', 'analysis_plot.png', {
                    'image_data': plot_image_bytes,
                    'x_scale': 0.4, 'y_scale': 0.6
                })
            except Exception:
                pass  # ， Excel
            worksheet.write('A1', f"Liquefaction Analysis Report - {metadata.get('Method', 'I&B 2014')}", title_fmt)

        # --- 5.  (Middle Section) ---
        worksheet.write(INFO_START_ROW, 0, "Project Parameters", subtitle_fmt)
        
        params = [
            ('Project:', metadata.get('Project', '-')),
            ('Location:', f"{metadata.get('Lat',0)}, {metadata.get('Lon',0)}"),
            ('Code:', metadata.get('Code', 'ASCE 7-22')),
            ('Method:', metadata.get('Method', 'I&B 2014')),
        ('Mw:', str(metadata.get('Mw', 7.5))),
        ('PGA:', f"{metadata.get('PGA', 0.4)} g"),
        ('GWT:', f"{metadata.get('GWT', 0)} {unit_labels['gwt_unit']}")
        ]
        
        # 
        for i, (k, v) in enumerate(params):
            r = INFO_START_ROW + 1 + (i // 4)
            c = (i % 4) * 3
            worksheet.write(r, c, k, label_fmt)
            worksheet.write(r, c+1, v, value_fmt)

        # --- 6.  (Bottom Section) ---
        #  Header
        for col_num, value in enumerate(export_df.columns.values):
            worksheet.write(TABLE_HEADER_ROW, col_num, value, header_fmt)
            
        # 
        widths = [8, 8, 8, 8, 10, 10, 10, 8, 10, 10, 10, 8, 12]
        for i, w in enumerate(widths):
            if i < len(export_df.columns):
                worksheet.set_column(i, i, w)
            
        # 
        # A-E ()
        worksheet.set_column('A:E', None, center_fmt)
        # F-G ()
        worksheet.set_column('F:G', None, float_fmt_2)
        # H-I (rd, CSR)
        worksheet.set_column('H:I', None, float_fmt_3)
        # J-K (N1, CRR)
        worksheet.set_column('J:K', None, float_fmt_3)
        # L (FS)
        worksheet.set_column('L:L', None, float_fmt_2)
        
        # : FS < 1.0 
        last_row = DATA_START_ROW + len(export_df)
        # FS  (L, index 11)
        fs_col_idx = 11
        if len(export_df.columns) > fs_col_idx:
            worksheet.conditional_format(DATA_START_ROW, fs_col_idx, last_row, fs_col_idx, {
                'type': 'cell', 'criteria': '<', 'value': 1.0, 'format': red_bg_fmt
            })
        # Liquefy  (M, index 12)
        liq_col_idx = 12
        if len(export_df.columns) > liq_col_idx:
            worksheet.conditional_format(DATA_START_ROW, liq_col_idx, last_row, liq_col_idx, {
                'type': 'text', 'criteria': 'containing', 'value': 'Yes', 'format': red_bg_fmt
            })
        
        # 
        white_default_fmt = workbook.add_format({
            'bg_color': 'white',
            'border': 1,
            'border_color': 'white'
        })
        # （）
        worksheet.set_column('A:Z', None, white_default_fmt)

        # --- 7.  (Below Table) ---
        # 
        last_data_row = DATA_START_ROW + len(export_df)  # 
        FORMULA_START_ROW = last_data_row + 2  # 
        
        method_name = metadata.get('Method', 'I&B 2014')
        
        # 
        if unit_system == 'imperial':
            depth_limit1 = "30 ft"
            depth_limit2 = "75 ft"
        else:
            depth_limit1 = "9.15 m"
            depth_limit2 = "23 m"
        
        if 'NCEER' in method_name:
            formulas = [
                "1. Stress Reduction (rd)",
                f"   rd = 1.0 - 0.00765*z  (z<={depth_limit1})",
                f"   rd = 1.174 - 0.0267*z ({depth_limit1.split()[0]}<z<={depth_limit2})",
                "",
                "2. Cyclic Stress Ratio (CSR)",
                "   CSR = 0.65 * (σv/σv') * PGA * rd / MSF",
                "",
                "3. SPT Corrections",
                "   N60 = N * CE * CB * CR * CS",
                "   CN = (Pa/σv')^0.5 <= 1.7",
                "   (N1)60 = N60 * CN",
                "",
                "4. Fines Content (FC) Correction",
                "   (N1)60cs = α + β * (N1)60",
                "",
                "5. Cyclic Resistance Ratio (CRR)",
                "   CRR7.5 = 1/(34-(N1)60cs) + ...",
                "",
                "6. Factor of Safety",
                "   FS = (CRR7.5 * MSF * Kσ) / CSR"
            ]
        else: # I&B 2014
            formulas = [
                "1. Stress Reduction (rd)",
                "   rd = exp(α(z) + β(z)*Mw)",
                "   α = -1.012 - 1.126*sin(z/11.73 + 5.133)",
                "   β = 0.106 + 0.118*sin(z/11.28 + 5.142)",
                "",
                "2. Overburden Correction (CN)",
                "   CN = (Pa/σv')^m <= 1.7",
                "   m = 0.784 - 0.0768*sqrt((N1)60cs)",
                "   (Requires Iteration)",
                "",
                "3. Fines Content (FC) Correction",
                "   ΔN1 = exp(1.63 + 9.7/FC - (15.7/FC)^2)",
                "   (N1)60cs = (N1)60 + ΔN1",
                "",
                "4. CRR (M=7.5, σ'=1)",
                "   CRR = exp( (N1)60cs/14.1 + ... - 2.8 )",
                "",
                "5. Magnitude Scaling Factor (MSF)",
                "   MSF = 6.9*exp(-Mw/4) - 0.058",
                "",
                "6. Factor of Safety",
                "   FS = CRR / CSR"
            ]
        
        #  "Methodology & Formulas"（）
        worksheet.write(FORMULA_START_ROW, 0, "Methodology & Formulas", formula_title_fmt)
        
        # （，）
        current_row = FORMULA_START_ROW + 1
        for line in formulas:
            if line.strip():  # 
                _write_formula_with_subscript(worksheet, current_row, 0, line, formula_box_fmt, formula_subscript_fmt)
            else:  # 
                worksheet.write(current_row, 0, "", formula_box_fmt)
            current_row += 1

        # --- 8. Symbol Description ---
        _create_symbol_description_sheet(workbook, unit_system=unit_system)

    output.seek(0)
    return output

def generate_multi_method_excel(method_results, unit_system='imperial'):
    """
     Excel 
    method_results: dict,  {method_code: {'df': DataFrame, 'metadata': dict, 'plot': BytesIO}}
    : {'IB2014': {...}, 'NCEER2001': {...}}
    unit_system: 'imperial'  'metric'
    """
    output = io.BytesIO()
    
    with pd.ExcelWriter(output, engine='xlsxwriter') as writer:
        workbook = writer.book
        title_fmt = workbook.add_format({'bold': True, 'font_size': 14})
        subhead_fmt = workbook.add_format({'bold': True, 'font_size': 11})

        # --- 1. SPT Plots sheet (new tab with all method plots) ---
        ws_plot = workbook.add_worksheet('SPT Plots')
        writer.sheets['SPT Plots'] = ws_plot
        ws_plot.write(0, 0, 'SPT Liquefaction Analysis Plots', title_fmt)
        plot_row = 2
        for method_code, result_data in method_results.items():
            method_display = result_data['metadata'].get('Method', 'I&B 2014')
            plot_bytes_io = result_data.get('plot')
            if plot_bytes_io and plot_bytes_io.getbuffer().nbytes >= 100:
                try:
                    if hasattr(plot_bytes_io, 'seek'):
                        plot_bytes_io.seek(0)
                    ws_plot.write(plot_row, 0, f'Method: {method_display}', subhead_fmt)
                    plot_row += 1
                    anchor = f'A{plot_row + 1}'
                    ws_plot.insert_image(anchor, f'spt_plot_{method_code}.png', {
                        'image_data': plot_bytes_io,
                        'x_scale': 0.85,
                        'y_scale': 0.85
                    })
                    plot_row += 42
                except Exception:
                    plot_row += 2

        # --- 2.  Methodology  tab（user ）---
        for method_code in method_results.keys():
            _create_spt_methodology_sheet(workbook, method_code, unit_system=unit_system)

        # --- 3.  data sheet ---
        sheet_names = []
        for method_code, result_data in method_results.items():
            method_display = result_data['metadata'].get('Method', 'I&B 2014')
            if method_code == 'IB2014':
                sheet_name = 'Analysis Report (I&B 2014)'
            elif method_code == 'NCEER2001':
                sheet_name = 'Analysis Report (NCEER 2001)'
            else:
                sheet_name = f'Analysis Report ({method_display})'
            sheet_names.append(sheet_name)
            df = result_data['df']
            metadata = result_data['metadata']
            plot_bytes_io = result_data['plot']
            if hasattr(plot_bytes_io, 'seek'):
                plot_bytes_io.seek(0)
            _create_single_method_sheet(workbook, sheet_name, df, metadata, plot_bytes_io, unit_system=unit_system)

        # --- 4. Symbol Description sheet () ---
        _create_symbol_description_sheet(workbook, unit_system=unit_system)
        
    output.seek(0)
    return output


# ==========================================
# CPT Liquefaction — Youd et al. (2001) / Robertson & Wride (1998)
# ==========================================
def calculate_cpt_liquefaction_youd2001(df_input, mw, pga, gwl_drill_ft, gwl_design_ft, an=0.8):
    """
    CPT liquefaction per Youd et al. (2001) / Robertson & Wride (1998).
    n-value 3-step switching: 1.0 (clay trial) → 0.5 → 0.7.
    Piecewise CRR7.5: (qc1N)cs < 50 vs 50 ≤ (qc1N)cs < 160.
    Returns (df_out, total_settlement_m).
    """
    PA = 101.325
    UNIT_WT_WATER = 9.81
    gwl_drill = float(gwl_drill_ft) * 0.3048
    gwl_design = float(gwl_design_ft) * 0.3048
    df = df_input.copy()
    df = df.sort_values('depth').reset_index(drop=True)

    df['qt'] = df['qc'] + df['u2'] * (1.0 - float(an))
    df['Rf'] = (df['fs'] / df['qt'].replace(0, 1e-9)) * 100.0

    sigma_v_list, sigma_ve_list, gamma_list = [], [], []
    curr_sigma_v = 0.0
    for i in range(len(df)):
        depth = float(df.loc[i, 'depth'])
        qt_val = max(float(df.loc[i, 'qt']), 1.0)
        rf_val = max(float(df.loc[i, 'Rf']), 0.1)
        sg_est = 0.27 * np.log10(rf_val) + 0.36 * np.log10(qt_val / PA) + 1.236
        gamma_soil = float(np.clip(sg_est * UNIT_WT_WATER, 14.0, 23.0))
        gamma_list.append(gamma_soil)
        thickness = max(0.0, depth - (float(df.loc[i - 1, 'depth']) if i > 0 else 0.0))
        curr_sigma_v += gamma_soil * thickness
        sigma_v_list.append(curr_sigma_v)
        u0 = max(0.0, (depth - gwl_drill) * UNIT_WT_WATER)
        sigma_ve_list.append(max(curr_sigma_v - u0, 1.0))
    df['gamma'] = gamma_list
    df['sigma_v'] = sigma_v_list
    df['sigma_ve'] = sigma_ve_list

    n_list, qc1N_list, Ic_list, Kc_list, qc1Ncs_list, Soil_Type_list, CRR_75_list, screened_out_list = [], [], [], [], [], [], [], []
    for i in range(len(df)):
        qt = float(df.loc[i, 'qt'])
        fs = float(df.loc[i, 'fs'])
        sig_v = float(df.loc[i, 'sigma_v'])
        sig_ve = float(df.loc[i, 'sigma_ve'])
        denom_q = max(qt - sig_v, 0.01 * PA)
        F = (fs / denom_q) * 100.0
        F_safe = max(F, 0.1)

        def compute_Q_and_Ic(n_val):
            Cn = min((PA / sig_ve) ** n_val, 1.7)
            Q = (qt - sig_v) / PA * Cn
            Q = max(Q, 0.1)
            Ic_val = float(np.sqrt((3.47 - np.log10(Q)) ** 2 + (np.log10(F_safe) + 1.22) ** 2))
            return Q, Ic_val, Cn

        n_final = 1.0
        Q_final, Ic_final, Cn_final = compute_Q_and_Ic(1.0)
        if Ic_final > 2.6:
            n_final = 1.0
            Soil_Type_list.append('Clay-like (Screened)')
            Kc = np.nan
            qc1Ncs_val = np.nan
            CRR_75_list.append(np.nan)
            screened_out_list.append(True)
        else:
            Q_05, Ic_05, Cn_05 = compute_Q_and_Ic(0.5)
            if Ic_05 < 2.6:
                n_final = 0.5
                Q_final, Ic_final, Cn_final = Q_05, Ic_05, Cn_05
            else:
                Q_07, Ic_07, Cn_07 = compute_Q_and_Ic(0.7)
                n_final = 0.7
                Q_final, Ic_final, Cn_final = Q_07, Ic_07, Cn_07
            Soil_Type_list.append('Sand-like')
            Kc = 1.0 if Ic_final <= 1.64 else float(
                -0.403 * (Ic_final ** 4) + 5.581 * (Ic_final ** 3) - 21.63 * (Ic_final ** 2) + 33.75 * Ic_final - 17.88
            )
            qc1Ncs_val = Kc * Q_final
            if qc1Ncs_val < 50:
                crr75 = 0.833 * (qc1Ncs_val / 1000.0) + 0.05
            elif qc1Ncs_val < 160:
                crr75 = 93.0 * (qc1Ncs_val / 1000.0) ** 3 + 0.08
            else:
                crr75 = 93.0 * (160.0 / 1000.0) ** 3 + 0.08
            CRR_75_list.append(crr75)
            screened_out_list.append(False)

        n_list.append(n_final)
        qc1N_list.append(float(Q_final))
        Ic_list.append(Ic_final)
        Kc_list.append(Kc)
        qc1Ncs_list.append(float(qc1Ncs_val))

    df['n'] = n_list
    df['qc1N'] = qc1N_list
    df['Ic'] = Ic_list
    df['Kc'] = Kc_list
    df['qc1Ncs'] = qc1Ncs_list
    df['Soil_Type'] = Soil_Type_list
    df['Screened_Out'] = screened_out_list
    df['CRR_7.5'] = CRR_75_list

    msf = min(max(6.9 * np.exp(-float(mw) / 4.0) - 0.058, 1.0), 1.8)
    rd_list, csr_list, crr_list, fs_list, strain_list, settlement_list = [], [], [], [], [], []
    for i in range(len(df)):
        depth = float(df.loc[i, 'depth'])
        sigma_v = float(df.loc[i, 'sigma_v'])
        u0_design = max(0.0, (depth - gwl_design) * UNIT_WT_WATER)
        sig_ve_design = max(sigma_v - u0_design, 1.0)
        rd = float(np.exp(-1.012 - 1.126 * np.sin(depth / 11.73 + 5.133) + (0.106 + 0.118 * np.sin(depth / 11.28 + 5.142)) * float(mw)))
        rd = min(rd, 1.0)
        csr = 0.65 * float(pga) * (sigma_v / sig_ve_design) * rd
        k_sigma = 1.0 if sig_ve_design <= PA else float(1.0 - 0.3 * np.log(sig_ve_design / PA))
        screened_out = bool(df.loc[i, 'Screened_Out'])
        if screened_out:
            capacity = np.nan
            fs_val = np.nan
        else:
            capacity = float(df.loc[i, 'CRR_7.5']) * msf * k_sigma
            fs_val = capacity / csr if csr > 0 else 10.0
            fs_val = min(fs_val, 5.0)
        rd_list.append(rd)
        csr_list.append(csr)
        crr_list.append(float(capacity) if np.isfinite(capacity) else np.nan)
        fs_list.append(fs_val)
        strain = 0.0
        if (not screened_out) and (fs_val < 1.0) and df.loc[i, 'Soil_Type'] == 'Sand-like':
            qc1ncs = float(df.loc[i, 'qc1Ncs'])
            max_strain = 5.0 if qc1ncs < 50 else (3.0 if qc1ncs < 90 else (1.0 if qc1ncs < 130 else 0.3))
            strain = max_strain * (1.0 - fs_val)
        thickness = max(0.0, depth - (float(df.loc[i - 1, 'depth']) if i > 0 else 0.0))
        settlement_list.append((strain / 100.0) * thickness)
        strain_list.append(strain)
    df['rd'] = rd_list
    df['CSR'] = csr_list
    df['CRR'] = crr_list
    df['FS'] = fs_list
    df['Liquefy'] = np.where(df['Screened_Out'], 'Screened (Ic>2.6)', np.where(pd.to_numeric(df['FS'], errors='coerce') < 1.0, 'Yes', 'No'))
    df['Strain_%'] = strain_list
    df['Settlement_m'] = settlement_list
    df['sigma_ve_design'] = [max(float(df.loc[i, 'sigma_v']) - max(0.0, (float(df.loc[i, 'depth']) - gwl_design) * UNIT_WT_WATER), 1.0) for i in range(len(df))]
    df['K_sigma'] = [1.0 if df.loc[i, 'sigma_ve_design'] <= PA else float(1.0 - 0.3 * np.log(df.loc[i, 'sigma_ve_design'] / PA)) for i in range(len(df))]
    df['MSF'] = msf
    total_settlement = float(df['Settlement_m'].sum())
    return df, total_settlement


# ==========================================
# CPT Liquefaction (Boulanger & Idriss, 2014) - Backend helper
# ==========================================
def calculate_cpt_liquefaction_bi2014(df_input, mw, pga, gwl_drill_ft, gwl_design_ft, an=0.8):
    """
    CPT liquefaction potential analysis (Boulanger & Idriss, 2014) based on CPT rows.

    Notes
    - Input CPT data must be sorted shallow-to-deep.
    - Expected units: depth in m, qc/fs/u2 in kPa. (gwl inputs are in ft; converted to m internally.)
    - This implementation follows the structure provided by the user and includes intermediate fields.

    Returns
    - (df_out, total_settlement_m)
    """
    # --- 0. constants / unit conversion ---
    PA = 101.325  # kPa
    UNIT_WT_WATER = 9.81  # kN/m^3

    gwl_drill = float(gwl_drill_ft) * 0.3048
    gwl_design = float(gwl_design_ft) * 0.3048

    df = df_input.copy()
    df = df.sort_values('depth').reset_index(drop=True)

    # --- 1. qt & Rf ---
    df['qt'] = df['qc'] + df['u2'] * (1.0 - float(an))
    df['Rf'] = (df['fs'] / df['qt'].replace(0, 1e-9)) * 100.0

    # --- 2. gamma & stresses (integrate) ---
    sigma_v_list = []
    sigma_ve_list = []
    gamma_list = []
    curr_sigma_v = 0.0

    for i in range(len(df)):
        depth = float(df.loc[i, 'depth'])
        qt_val = float(df.loc[i, 'qt'])
        rf_val = float(df.loc[i, 'Rf'])

        qt_safe = max(qt_val, 1.0)
        rf_safe = max(rf_val, 0.1)

        # Robertson & Cabal (2010) unit weight estimate
        sg_est = 0.27 * np.log10(rf_safe) + 0.36 * np.log10(qt_safe / PA) + 1.236
        gamma_soil = sg_est * UNIT_WT_WATER
        gamma_soil = float(np.clip(gamma_soil, 14.0, 23.0))
        gamma_list.append(gamma_soil)

        thickness = depth - (float(df.loc[i - 1, 'depth']) if i > 0 else 0.0)
        thickness = max(thickness, 0.0)

        curr_sigma_v += gamma_soil * thickness
        sigma_v_list.append(curr_sigma_v)

        # effective stress at drilling gwl (for normalization)
        u0_drill = max(0.0, (depth - gwl_drill) * UNIT_WT_WATER)
        sigma_ve_val = curr_sigma_v - u0_drill
        sigma_ve_list.append(max(float(sigma_ve_val), 1.0))

    df['gamma'] = gamma_list
    df['sigma_v'] = sigma_v_list
    df['sigma_ve'] = sigma_ve_list

    # --- 3. I&B 2014: FCeq from Ic, iterative CN convergence, qc1Ncs ---
    Cn_list = []
    qc1N_list = []
    delta_qc1N_list = []
    qc1Ncs_list = []
    m_list = []
    Fc_eq_list = []
    Ic_list = []

    for i in range(len(df)):
        qt = float(df.loc[i, 'qt'])
        fr = float(df.loc[i, 'Rf'])
        sig_ve = float(df.loc[i, 'sigma_ve'])
        denom_q = max(qt - sig_ve, 0.01 * PA)
        F = (float(df.loc[i, 'fs']) / denom_q) * 100.0
        F_safe = max(F, 0.1)

        # Preliminary Ic (n=1) for FCeq
        qc1N_init = max(qt / PA, 0.1)
        Ic_prelim = float(np.sqrt((3.47 - np.log10(qc1N_init)) ** 2 + (np.log10(F_safe) + 1.22) ** 2))
        FCeq = 1.375 * (Ic_prelim ** 3) - 3.51 * (Ic_prelim ** 2) - 1.43 * Ic_prelim - 16.5
        FCeq = float(np.clip(FCeq, 0.0, 100.0))
        Fc_eq_list.append(FCeq)

        # Iterative CN convergence
        CN = 1.0
        for _ in range(20):
            qc1N = CN * (qt / PA)
            qc1N = max(qc1N, 0.1)
            delta_qc1N = (11.9 + qc1N / 14.6) * np.exp(
                1.63 - 9.7 / (FCeq + 2.0) - (15.7 / (FCeq + 2.0)) ** 2
            )
            qc1Ncs = qc1N + delta_qc1N
            m = 1.338 - 0.249 * (qc1Ncs ** 0.264)
            CN_new = min((PA / sig_ve) ** m, 1.7)
            if abs(CN_new - CN) <= 0.001:
                break
            CN = CN_new

        Ic = float(np.sqrt((3.47 - np.log10(qc1N)) ** 2 + (np.log10(F_safe) + 1.22) ** 2))
        Cn_list.append(float(CN))
        qc1N_list.append(float(qc1N))
        delta_qc1N_list.append(float(delta_qc1N))
        qc1Ncs_list.append(float(qc1Ncs))
        m_list.append(float(m))
        Ic_list.append(Ic)

    df['Cn'] = Cn_list
    df['qc1N'] = qc1N_list
    df['delta_qc1N'] = delta_qc1N_list
    df['qc1Ncs'] = qc1Ncs_list
    df['m'] = m_list
    df['Fc_eq'] = Fc_eq_list
    df['Ic'] = Ic_list
    df['Qtn'] = qc1N_list
    df['Qtn_cs'] = qc1Ncs_list

    # --- 4. CRR_7.5 (I&B 2014 smooth formula: 137 in 4th term) ---
    def calc_crr_75(qc1ncs):
        q = float(qc1ncs)
        if q < 0:
            return 0.1
        return float(np.exp(q / 113.0 + (q / 1000.0) ** 2 - (q / 140.0) ** 3 + (q / 137.0) ** 4 - 2.8))

    df['Screened_Out'] = df['Ic'].apply(lambda x: bool(x is not None and float(x) > 2.6))
    df['Soil_Type'] = df['Screened_Out'].apply(lambda v: 'Clay-like (Screened)' if bool(v) else 'Sand-like')
    df['CRR_7.5'] = df.apply(lambda row: calc_crr_75(row['qc1Ncs']) if not bool(row['Screened_Out']) else np.nan, axis=1)

    # --- 5. CSR, FS, rd, settlement ---
    rd_list = []
    csr_list = []
    fs_list = []
    strain_pct_list = []
    settlement_list = []
    u0_design_list = []
    sigma_ve_design_list = []
    k_sigma_list = []
    msf_list = []
    crr_capacity_list = []

    msf = 6.9 * np.exp(-float(mw) / 4.0) - 0.058
    msf = float(min(max(msf, 1.0), 1.8))

    for i in range(len(df)):
        depth = float(df.loc[i, 'depth'])
        sigma_v = float(df.loc[i, 'sigma_v'])

        u0_design = max(0.0, (depth - gwl_design) * UNIT_WT_WATER)
        sig_ve_design = sigma_v - u0_design
        sig_ve_design = max(float(sig_ve_design), 1.0)
        u0_design_list.append(float(u0_design))
        sigma_ve_design_list.append(float(sig_ve_design))

        alpha = -1.012 - 1.126 * np.sin(depth / 11.73 + 5.133)
        beta = 0.106 + 0.118 * np.sin(depth / 11.28 + 5.142)
        rd = float(np.exp(alpha + beta * float(mw)))
        rd = min(rd, 1.0)
        rd_list.append(rd)

        k_sigma = 1.0
        if sig_ve_design > PA:
            k_sigma = float(1.0 - 0.3 * np.log(sig_ve_design / PA))
        k_sigma_list.append(float(k_sigma))
        msf_list.append(float(msf))

        csr_raw = 0.65 * float(pga) * (sigma_v / sig_ve_design) * rd
        demand = csr_raw
        screened_out = bool(df.loc[i, 'Screened_Out'])
        if screened_out:
            capacity = np.nan
            fs = np.nan
        else:
            capacity = float(df.loc[i, 'CRR_7.5']) * msf * k_sigma
            fs = capacity / demand if demand > 0 else 10.0
            fs = float(min(fs, 5.0))
        crr_capacity_list.append(float(capacity) if np.isfinite(capacity) else np.nan)

        csr_list.append(float(demand))
        fs_list.append(fs)

        # Settlement (simplified Zhang et al. 2002 style)
        qtn_cs = float(df.loc[i, 'Qtn_cs'])
        strain = 0.0  # percent
        if (not screened_out) and (fs < 1.0) and df.loc[i, 'Soil_Type'] == 'Sand-like':
            if qtn_cs < 50:
                max_strain = 5.0
            elif qtn_cs < 90:
                max_strain = 3.0
            elif qtn_cs < 130:
                max_strain = 1.0
            else:
                # Avoid a hard zero: very dense sands can still experience small volumetric strains.
                # Keep a conservative lower-bound so "FS<1 but settlement=0" does not occur.
                max_strain = 0.3
            strain = max_strain * (1.0 - fs)

        thickness = depth - (float(df.loc[i - 1, 'depth']) if i > 0 else 0.0)
        thickness = max(thickness, 0.0)
        layer_settlement = (strain / 100.0) * thickness

        strain_pct_list.append(float(strain))
        settlement_list.append(float(layer_settlement))

    df['rd'] = rd_list
    df['CSR'] = csr_list
    df['CRR'] = crr_capacity_list
    df['FS'] = fs_list
    df['Liquefy'] = np.where(df['Screened_Out'], 'Screened (Ic>2.6)', np.where(pd.to_numeric(df['FS'], errors='coerce') < 1.0, 'Yes', 'No'))
    df['Strain_%'] = strain_pct_list
    df['Settlement_m'] = settlement_list
    df['u0_design'] = u0_design_list
    df['sigma_ve_design'] = sigma_ve_design_list
    df['K_sigma'] = k_sigma_list
    df['MSF'] = msf_list

    total_settlement = float(df['Settlement_m'].sum())
    return df, total_settlement

def _create_single_method_sheet(workbook, sheet_name, df, metadata, plot_image_bytes=None, unit_system='imperial'):
    """sheet"""
    worksheet = workbook.add_worksheet(sheet_name)
    
    # 
    unit_labels = get_unit_labels(unit_system)
    
    # generate_us_style_excel
    # 
    # Output columns (audit-friendly; missing columns are filled with blanks/zeros)
    # Keep this as a superset so both NCEER2001 and I&B2014 can share the same sheet structure.
    output_columns = [
        'depth', 'soil_class', 'spt_n', 'fc', 'PI', 'gamma',
        'sigma_v', 'sigma_ve',
        'rd', 'CSR',
        'CN', 'm', 'N60', 'N1_60', 'delta_N1_60', 'N1_60cs',
        'alpha', 'beta',
        'CRR_7.5', 'MSF_max', 'MSF', 'C_sigma', 'K_sigma',
        'CRR', 'FS', 'Liquefy'
    ]
    
    for col in output_columns:
        if col not in df.columns:
            df[col] = '' if col == 'soil_class' else 0
    
    # 
    if unit_system == 'imperial':
        column_mapping = {
            'depth': 'Depth\n(ft)',
            'soil_class': 'Soil\nType',
            'spt_n': 'SPT N\n(meas)',
            'fc': 'Fines\n(%)',
            'PI': 'PI',
            'gamma': 'Unit Wt\n(pcf)',
            'sigma_v': 'σv\n(tsf)',
            'sigma_ve': 'σ\'v\n(tsf)',
            'rd': 'rd',
            'CSR': 'CSR\n(Load)',
            'CN': 'C_N',
            'm': 'm',
            'N60': 'N60',
            'N1_60': '(N1)60',
            'delta_N1_60': 'ΔN1,60',
            'N1_60cs': '(N1)60cs',
            'alpha': 'α(FC)',
            'beta': 'β(FC)',
            'CRR_7.5': 'CRR7.5',
            'MSF_max': 'MSF_max',
            'MSF': 'MSF',
            'C_sigma': 'C_σ',
            'K_sigma': 'K_σ',
            'CRR': 'CRR\n(Capacity)',
            'FS': 'FS',
            'Liquefy': 'Liquefaction\nPotential'
        }
    else:  # metric
        column_mapping = {
            'depth': 'Depth\n(m)',
            'soil_class': 'Soil\nType',
            'spt_n': 'SPT N\n(meas)',
            'fc': 'Fines\n(%)',
            'PI': 'PI',
            'gamma': 'Unit Wt\n(kN/m³)',
            'sigma_v': 'σv\n(kPa)',
            'sigma_ve': 'σ\'v\n(kPa)',
            'rd': 'rd',
            'CSR': 'CSR\n(Load)',
            'CN': 'C_N',
            'm': 'm',
            'N60': 'N60',
            'N1_60': '(N1)60',
            'delta_N1_60': 'ΔN1,60',
            'N1_60cs': '(N1)60cs',
            'alpha': 'α(FC)',
            'beta': 'β(FC)',
            'CRR_7.5': 'CRR7.5',
            'MSF_max': 'MSF_max',
            'MSF': 'MSF',
            'C_sigma': 'C_σ',
            'K_sigma': 'K_σ',
            'CRR': 'CRR\n(Capacity)',
            'FS': 'FS',
            'Liquefy': 'Liquefaction\nPotential'
        }
    
    export_df = df[output_columns].copy()
    export_df.rename(columns=column_mapping, inplace=True)
    
    # 
    IMG_START_ROW = 1
    IMG_END_ROW = 18  # ，
    INFO_START_ROW = 25  # Project Parameters  5 （ 20）
    TABLE_HEADER_ROW = 29  #  5 （ 24）
    DATA_START_ROW = 30  #  5 （ 25）
    
    # 
    # （）
    white_border_fmt = workbook.add_format({
        'bg_color': 'white',
        'border': 1,
        'border_color': 'white'
    })
    
    # （）
    header_fmt = workbook.add_format({
        'bold': True, 'text_wrap': True, 'valign': 'vcenter', 'align': 'center',
        'fg_color': '#D3D3D3', 'font_color': 'black', 'border': 1
    })
    center_fmt = workbook.add_format({'align': 'center', 'valign': 'vcenter', 'border': 1})
    float_fmt_2 = workbook.add_format({'num_format': '0.00', 'align': 'center', 'valign': 'vcenter', 'border': 1})
    float_fmt_3 = workbook.add_format({'num_format': '0.000', 'align': 'center', 'valign': 'vcenter', 'border': 1})
    
    # （）
    label_fmt = workbook.add_format({
        'bold': True, 'align': 'right', 'font_size': 11,
        'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    value_fmt = workbook.add_format({
        'align': 'left', 'font_size': 11,
        'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    title_fmt = workbook.add_format({
        'bold': True, 'font_size': 16,
        'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    subtitle_fmt = workbook.add_format({
        'bold': True, 'font_size': 12, 'underline': True,
        'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    
    red_bg_fmt = workbook.add_format({'bg_color': '#FFC7CE', 'font_color': '#9C0006', 'border': 1, 'align': 'center'})
    formula_box_fmt = workbook.add_format({
        'bg_color': 'white', 'border': 1, 'border_color': 'white',
        'valign': 'top', 'text_wrap': False, 'font_size': 9
    })
    formula_title_fmt = workbook.add_format({
        'bg_color': 'white', 'border': 1, 'border_color': 'white',
        'font_color': 'black', 'bold': True, 'align': 'left', 'font_size': 12,
        'text_wrap': False, 'valign': 'top'
    })
    # （）
    formula_subscript_fmt = workbook.add_format({
        'bg_color': 'white', 'border': 1, 'border_color': 'white',
        'font_script': 2, 'font_size': 9  # font_script: 2 = subscript
    })
    
    # （， Excel）
    if plot_image_bytes:
        try:
            if isinstance(plot_image_bytes, bytes):
                plot_image_bytes = io.BytesIO(plot_image_bytes)
            elif not hasattr(plot_image_bytes, 'seek'):
                plot_image_bytes = io.BytesIO(plot_image_bytes)
            plot_image_bytes.seek(0)
            if plot_image_bytes.getbuffer().nbytes >= 100:
                worksheet.insert_image('A2', 'analysis_plot.png', {
                    'image_data': plot_image_bytes,
                    'x_scale': 0.6, 'y_scale': 0.7
                })
        except Exception:
            pass
    worksheet.write('A1', f"Liquefaction Analysis Report - {metadata.get('Method', 'I&B 2014')}", title_fmt)
    
    # 
    worksheet.write(INFO_START_ROW, 0, "Project Parameters", subtitle_fmt)
    gwt_unit = unit_labels.get('gwt_unit', 'm')
    params = [
        ('Project:', metadata.get('Project', '-')),
        ('Location:', f"{metadata.get('Lat',0)}, {metadata.get('Lon',0)}"),
        ('Code:', metadata.get('Code', 'ASCE 7-22')),
        ('Method:', metadata.get('Method', 'I&B 2014')),
        ('Mw:', str(metadata.get('Mw', 7.5))),
        ('PGA:', f"{metadata.get('PGA', 0.4)} g"),
        ('GWT:', f"{metadata.get('GWT', 0)} {gwt_unit}")
    ]
    for i, (k, v) in enumerate(params):
        r = INFO_START_ROW + 1 + (i // 4)
        c = (i % 4) * 3
        worksheet.write(r, c, k, label_fmt)
        worksheet.write(r, c+1, v, value_fmt)
    
    # 
    for col_num, value in enumerate(export_df.columns.values):
        worksheet.write(TABLE_HEADER_ROW, col_num, value, header_fmt)
    
    # （format by column name, not hard-coded indices）
    float2_cols = {'depth', 'gamma', 'sigma_v', 'sigma_ve', 'FS', 'N60', 'N1_60', 'N1_60cs'}
    float3_cols = {'rd', 'CSR', 'CRR', 'CRR_7.5', 'CN', 'm', 'delta_N1_60', 'MSF_max', 'MSF', 'C_sigma', 'K_sigma', 'alpha', 'beta'}
    center_cols = {'soil_class', 'Liquefy'}
    for row_idx, (_, row_data) in enumerate(export_df.iterrows()):
        for col_idx, (col_name, value) in enumerate(zip(export_df.columns, row_data)):
            base_name = None
            # export_df columns are already mapped to display labels; use original list for type mapping
            try:
                base_name = output_columns[col_idx]
            except Exception:
                base_name = None

            if base_name in center_cols:
                fmt = center_fmt
            elif base_name in float2_cols:
                fmt = float_fmt_2
            elif base_name in float3_cols:
                fmt = float_fmt_3
            else:
                fmt = center_fmt
            worksheet.write(DATA_START_ROW + row_idx, col_idx, value, fmt)
    
    # 
    widths = [8, 10, 9, 9, 6, 10, 10, 10, 8, 10, 8, 7, 8, 9, 10, 10, 10, 8, 8, 9, 9, 9, 9, 9, 9, 8, 14]
    for i, w in enumerate(widths):
        if i < len(export_df.columns):
            worksheet.set_column(i, i, w)
    
    # 
    white_default_fmt = workbook.add_format({
        'bg_color': 'white',
        'border': 1,
        'border_color': 'white'
    })
    # （）
    worksheet.set_column('A:Z', None, white_default_fmt)
    
    #  (find columns by name, so adding columns won't break formatting)
    last_row = DATA_START_ROW + len(export_df)
    try:
        fs_idx = output_columns.index('FS')
        liq_idx = output_columns.index('Liquefy')
        worksheet.conditional_format(DATA_START_ROW, fs_idx, last_row, fs_idx, {
            'type': 'cell', 'criteria': '<', 'value': 1.0, 'format': red_bg_fmt
        })
        worksheet.conditional_format(DATA_START_ROW, liq_idx, last_row, liq_idx, {
            'type': 'text', 'criteria': 'containing', 'value': 'Yes', 'format': red_bg_fmt
        })
    except Exception:
        pass
    
    # 
    white_default_fmt = workbook.add_format({
        'bg_color': 'white',
        'border': 1,
        'border_color': 'white'
    })
    # （）
    worksheet.set_column('A:Z', None, white_default_fmt)
    
    # （）
    last_data_row = DATA_START_ROW + len(export_df)  # 
    FORMULA_START_ROW = last_data_row + 2  # 
    
    method_name = metadata.get('Method', 'I&B 2014')
    if 'NCEER' in method_name:
        formulas = [
            "1. Stress Reduction (rd)",
            "   rd = 1.0 - 0.00765*z (z<=30 ft)",
            "   rd = 1.174 - 0.0267*z (30<z<=75 ft)",
            "",
            "2. Cyclic Stress Ratio (CSR)",
            "   CSR = 0.65 * (σv/σv') * PGA * rd / MSF",
            "",
            "3. SPT Corrections",
            "   N60 = N * CE * CB * CR * CS",
            "   CN = (Pa/σv')^0.5 <= 1.7",
            "   (N1)60 = N60 * CN",
            "",
            "4. Fines Content (FC) Correction",
            "   (N1)60cs = α + β * (N1)60",
            "",
            "5. Cyclic Resistance Ratio (CRR)",
            "   CRR7.5 = 1/(34-(N1)60cs) + ...",
            "",
            "6. Factor of Safety",
            "   FS = (CRR7.5 * MSF * Kσ) / CSR"
        ]
    else:
        formulas = [
            "1. Stress Reduction (rd)",
            "   rd = exp(α(z) + β(z)*Mw)",
            "   α = -1.012 - 1.126*sin(z/11.73 + 5.133)",
            "   β = 0.106 + 0.118*sin(z/11.28 + 5.142)",
            "",
            "2. Overburden Correction (CN)",
            "   CN = (Pa/σv')^m <= 1.7",
            "   m = 0.784 - 0.0768*sqrt((N1)60cs)",
            "   (Requires Iteration)",
            "",
            "3. Fines Content (FC) Correction",
            "   ΔN1 = exp(1.63 + 9.7/FC - (15.7/FC)^2)",
            "   (N1)60cs = (N1)60 + ΔN1",
            "",
            "4. CRR (M=7.5, σ'=1)",
            "   CRR = exp( (N1)60cs/14.1 + ... - 2.8 )",
            "",
            "5. Magnitude Scaling Factor (MSF)",
            "   MSF = 6.9*exp(-Mw/4) - 0.058",
            "",
            "6. Factor of Safety",
            "   FS = CRR / CSR"
        ]
    
    #  "Methodology & Formulas"（）
    worksheet.write(FORMULA_START_ROW, 0, "Methodology & Formulas", formula_title_fmt)
    
    # （，）
    current_row = FORMULA_START_ROW + 1
    for line in formulas:
        if line.strip():  # 
            _write_formula_with_subscript(worksheet, current_row, 0, line, formula_box_fmt, formula_subscript_fmt)
        else:  # 
            worksheet.write(current_row, 0, "", formula_box_fmt)
        current_row += 1

def _write_cpt_methodology_to_worksheet(worksheet, workbook, method_code, start_row=0):
    """
    Write CPT methodology content to an existing worksheet at start_row.
    Returns the row index after the last written line (for appending data below).
    """
    if method_code == 'Youd2001':
        title = 'Methodology & Formulas — Robertson (2009) / Youd et al. (2001) CPT'
        formulas = [
            ('1. n-value 3-step switching (no iteration)', ''),
            ('   Trial 1 (n=1, assume clay): Q = (qc−σv)/Pa / (σ\'v/Pa)^1, F = (fs/(qc−σv))×100%', ''),
            ('   Ic = √[(3.47−log10(Q))² + (log10(F)+1.22)²]', ''),
            ('   If Ic > 2.6 → Clay-like (screened out); RW98 sand CRR/FS not evaluated', ''),
            ('   If Ic < 2.6 → Trial 2: n=0.5, recompute Q, Ic', ''),
            ('   If Ic(n=0.5) < 2.6 → use n=0.5', ''),
            ('   If Ic(n=0.5) > 2.6 → Trial 3: n=0.7', ''),
            ('', ''),
            ('2. Clean-sand correction (Kc)', ''),
            ('   Ic ≤ 1.64: Kc = 1.0', ''),
            ('   Ic > 1.64: Kc = −0.403×Ic⁴ + 5.581×Ic³ − 21.63×Ic² + 33.75×Ic − 17.88', ''),
            ('   (qc1N)cs = Kc × qc1N', ''),
            ('', ''),
            ('3. CRR7.5 (piecewise)', ''),
            ('   (qc1N)cs < 50: CRR7.5 = 0.833×((qc1N)cs/1000) + 0.05', ''),
            ('   50 ≤ (qc1N)cs < 160: CRR7.5 = 93×((qc1N)cs/1000)³ + 0.08', ''),
            ('', ''),
            ('4. CSR, rd, MSF, Kσ, FS (same as I&B)', ''),
        ]
    else:
        title = 'Methodology & Formulas — Boulanger & Idriss (2014) CPT Liquefaction'
        formulas = [
            ('1. FCeq from preliminary Ic', ''),
            ('   FCeq = 1.375×Ic³ − 3.51×Ic² − 1.43×Ic − 16.5', 'clamped [0, 100]'),
            ('', ''),
            ('2. Iterative CN convergence (|ΔCN| ≤ 0.001)', ''),
            ('   Start CN = 1.0. Loop:', ''),
            ('   qc1N = CN × (qt/Pa)', ''),
            ('   Δqc1N = (11.9 + qc1N/14.6) × exp(1.63 − 9.7/(FCeq+2) − (15.7/(FCeq+2))²)', ''),
            ('   qc1Ncs = qc1N + Δqc1N', ''),
            ('   m = 1.338 − 0.249×(qc1Ncs)^0.264', ''),
            ('   CN_new = (Pa/σ\'v)^m ≤ 1.7', ''),
            ('', ''),
            ('3. CRR7.5 (smooth)', ''),
            ('   CRR7.5 = exp(qc1Ncs/113 + (qc1Ncs/1000)² − (qc1Ncs/140)³ + (qc1Ncs/137)⁴ − 2.8)', ''),
            ('', ''),
            ('4. CSR, rd, MSF, Kσ, FS', ''),
        ]
    title_fmt = workbook.add_format({
        'bold': True, 'font_size': 14, 'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    formula_fmt = workbook.add_format({
        'font_size': 10, 'bg_color': 'white', 'border': 1, 'border_color': 'white',
        'valign': 'top', 'text_wrap': False
    })
    formula_sub_fmt = workbook.add_format({
        'font_size': 10, 'font_script': 2, 'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    row = start_row
    worksheet.write(row, 0, title, title_fmt)
    row += 2
    for line, note in formulas:
        if line.strip():
            _write_formula_with_subscript(worksheet, row, 0, line, formula_fmt, formula_sub_fmt)
        if note.strip():
            worksheet.write(row, 1, note, formula_fmt)
        row += 1
    worksheet.set_column('A:A', 55)
    worksheet.set_column('B:B', 45)
    return row


def _create_cpt_methodology_sheet(workbook, method_code='IB2014', unit_system='imperial'):
    """
     CPT （ sheet， batch ）
    method_code: 'Youd2001' (R&W 1998)  'IB2014' (Boulanger & Idriss 2014)
    """
    sheet_name = 'Methodology (Youd 2001 CPT)' if method_code == 'Youd2001' else 'Methodology (B&I 2014 CPT)'
    ws = workbook.add_worksheet(sheet_name)
    _write_cpt_methodology_to_worksheet(ws, workbook, method_code, start_row=0)


def _create_spt_methodology_sheet(workbook, method_code, unit_system='imperial'):
    """
     SPT 
    method_code: 'IB2014'  'NCEER2001'
     user ， methodology tab
     Youd et al. (2001) / Idriss & Boulanger (2014) 
    """
    z_unit = 'm' if unit_system == 'metric' else 'ft'
    if method_code == 'NCEER2001':
        sheet_name = 'Methodology (NCEER 2001)'
        title = 'Methodology & Formulas — NCEER (Youd et al., 2001) SPT Liquefaction'
        formulas = [
            "0. Clay-Like Gatekeeper (Simplified): PI ≥ 7 → flag as non-liquefiable, skip CRR math",
            "",
            "1. Seismic Demand (CSR) & Stress Reduction (rd) — Liao & Whitman (1986)",
            "   CSR = 0.65 × (PGA/g) × (σv/σ'v) × rd",
            f"   z ≤ 9.15 m:  rd = 1.0 − 0.00765×z",
            f"   9.15 < z ≤ 23 m:  rd = 1.174 − 0.0267×z",
            "",
            "2. Fines Content (FC) Correction — Equivalent Clean-Sand Blow Count",
            "   (N1)60cs = α + β × (N1)60",
            "   FC ≤ 5%:  α = 0,  β = 1.0",
            "   5% < FC < 35%:  α = exp(1.76 − 190/FC²),  β = 0.99 + FC^1.5/1000",
            "   FC ≥ 35%:  α = 5.0,  β = 1.2",
            "",
            "3. Base Resistance CRR7.5 (Rauch approximation)",
            "   CRR7.5 = 1/(34−(N1)60cs) + (N1)60cs/135 + 50/(10×(N1)60cs+45)² − 1/200",
            "",
            "4. Magnitude Scaling Factor (MSF)",
            "   MSF = 10^2.24 / Mw^2.56  (Youd, max 1.5)",
            "",
            "5. Overburden Correction (Kσ)",
            "   Kσ = (σ'v/Pa)^(f−1),  f = 0.6~0.8 (density-dependent)",
            "",
            "6. Factor of Safety",
            "   FS = (CRR7.5 × MSF × Kσ) / CSR"
        ]
    else:
        sheet_name = 'Methodology (I&B 2014)'
        title = 'Methodology & Formulas — Idriss & Boulanger (2014) SPT Liquefaction'
        formulas = [
            "0. Clay-Like Gatekeeper (Simplified): PI ≥ 7 → flag as non-liquefiable, skip CRR math",
            "",
            "1. Seismic Demand (CSR) & Stress Reduction (rd)",
            "   CSR = 0.65 × (PGA/g) × (σv/σ'v) × rd",
            "   rd = exp(α(z) + β(z)×Mw)",
            "   α(z) = −1.012 − 1.126×sin(z/11.73 + 5.133)",
            "   β(z) = 0.106 + 0.118×sin(z/11.28 + 5.142)  [z in m, radians]",
            "",
            "2. Iterative SPT Correction (CN depends on (N1)60cs, which depends on CN)",
            "   Start: CN = 1.0. Loop until |ΔCN| < 0.001:",
            "   (N1)60 = N×CE×CB×CR×CS×CN",
            "   ΔN1,60 = exp(1.63 + 9.7/(FC+0.01) − (15.7/(FC+0.01))²)",
            "   (N1)60cs = (N1)60 + ΔN1,60",
            "   m = 0.784 − 0.0768×√(N1)60cs",
            "   CN = (Pa/σ'v)^m ≤ 1.7",
            "",
            "3. Base Resistance CRR7.5",
            "   CRR7.5 = exp((N1)60cs/14.1 + ((N1)60cs/126)² − ((N1)60cs/23.6)³ + ((N1)60cs/25.4)⁴ − 2.8)",
            "",
            "4. Magnitude Scaling Factor (MSF)",
            "   MSFmax = 1.09 + ((N1)60cs/31.5)² ≤ 2.2",
            "   MSF = 1 + (MSFmax−1)×(8.64×exp(−Mw/4) − 1.325)",
            "",
            "5. Overburden Correction (Kσ)",
            "   Cσ = 1/(18.9 − 2.55×√(N1)60cs) ≤ 0.3",
            "   Kσ = 1 − Cσ×ln(σ'v/Pa) ≤ 1.1",
            "",
            "6. Factor of Safety",
            "   FS = (CRR7.5 × MSF × Kσ) / CSR"
        ]
    ws = workbook.add_worksheet(sheet_name)
    title_fmt = workbook.add_format({
        'bold': True, 'font_size': 14, 'bg_color': 'white', 'border': 1, 'border_color': 'white'
    })
    formula_box_fmt = workbook.add_format({
        'bg_color': 'white', 'border': 1, 'border_color': 'white',
        'valign': 'top', 'text_wrap': False, 'font_size': 10
    })
    formula_subscript_fmt = workbook.add_format({
        'bg_color': 'white', 'border': 1, 'border_color': 'white',
        'font_script': 2, 'font_size': 10
    })
    row = 0
    ws.write(row, 0, title, title_fmt)
    row += 2
    for line in formulas:
        if line.strip():
            _write_formula_with_subscript(ws, row, 0, line, formula_box_fmt, formula_subscript_fmt)
        else:
            ws.write(row, 0, "", formula_box_fmt)
        row += 1
    ws.set_column('A:A', 55)


def _create_symbol_description_sheet(workbook, unit_system='imperial', test_type='SPT'):
    """（，）
    test_type: 'SPT' or 'CPT'
    """
    symbol_worksheet = workbook.add_worksheet('Symbol Description')
    
    # （）
    symbol_title_fmt = workbook.add_format({
        'bold': True, 'font_size': 16, 'align': 'center', 'valign': 'vcenter',
        'bg_color': 'white'
    })
    symbol_header_fmt = workbook.add_format({
        'bold': True, 'font_size': 11, 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'text_wrap': False, 'bg_color': 'white'
    })
    symbol_desc_fmt = workbook.add_format({
        'font_size': 10, 'align': 'left', 'valign': 'top',
        'border': 1, 'text_wrap': True, 'bg_color': 'white'
    })
    symbol_symbol_fmt = workbook.add_format({
        'font_size': 11, 'align': 'center', 'valign': 'vcenter',
        'border': 1, 'bold': True, 'bg_color': 'white'
    })

    if test_type == 'CPT':
        symbol_worksheet.merge_range('A1:D1', 'Symbol Description (CPT — Robertson 2009 & Boulanger & Idriss 2014)', symbol_title_fmt)
        symbol_worksheet.write('A2', 'Symbol', symbol_header_fmt)
        symbol_worksheet.write('B2', 'Description', symbol_header_fmt)
        symbol_worksheet.write('C2', 'Metric', symbol_header_fmt)
        symbol_worksheet.write('D2', 'Imperial', symbol_header_fmt)
        cpt_symbols = [
            ('z, depth', 'Depth below ground surface. Vertical distance from ground level to the measurement point.', 'm', 'ft'),
            ('qc', 'Cone tip resistance. Total force on the cone tip divided by its projected area. Primary CPT measurement for soil strength.', 'kPa', 'tsf'),
            ('fs', 'Sleeve friction. Frictional resistance on the friction sleeve. Used with qc to compute friction ratio Rf.', 'kPa', 'tsf'),
            ('u₂', 'Pore pressure at u2 position (behind cone). Measured during penetration; used for qt correction and soil behavior assessment.', 'kPa', 'tsf'),
            ('qt', 'Corrected cone resistance. qt = qc + (1 − aₙ)×u₂, where aₙ is net area ratio. Corrects for unequal end-area effect.', 'kPa', 'tsf'),
            ('Rf', 'Friction ratio. Rf = (fs/qt)×100 (%). Ratio of sleeve friction to cone resistance; indicates soil type.', '%', '%'),
            ('γ', 'Unit weight of soil. Estimated from Robertson & Cabal (2010) or similar correlation using Qt and Fr.', 'kN/m³', 'pcf'),
            ('σv0', 'Total vertical overburden stress. Sum of soil weight above the depth; σv0 = Σ(γ × thickness) from surface.', 'kPa', 'tsf'),
            ("σ′v0", 'Effective vertical stress (drilling GWL). σ′v0 = σv0 − u₀, where u₀ uses drilling groundwater level. Used for CPT normalization.', 'kPa', 'tsf'),
            ("σ′v0,design", 'Effective vertical stress (design GWL). Same as σ′v0 but uses design earthquake groundwater level. Used for CSR and CRR.', 'kPa', 'tsf'),
            ('Cn', 'Overburden correction factor for CPT. Cn = (Pa/σ′v)^n ≤ 1.7. Normalizes cone resistance to reference stress.', '-', '-'),
            ('n', 'Exponent in Cn. Iteratively determined: n=1.0 (clay trial), then 0.5 or 0.7 for sand. Robertson & Wride (1998).', '-', '-'),
            ('Qtn, qc1N', 'Normalized cone resistance. Qtn = (qt − σv0)/Pa × Cn. Dimensionless normalized resistance before Kc.', '-', '-'),
            ('Kc', 'Clean-sand correction factor. Kc = f(Ic); applied to Qtn to obtain clean-sand equivalent. Robertson & Wride (1998).', '-', '-'),
            ('qc1Ncs, Qtn_cs', 'Clean-sand equivalent normalized resistance. qc1Ncs = Kc × Qtn. Used to evaluate CRR7.5 for liquefaction.', '-', '-'),
            ('Ic', 'Soil behavior type index. Ic = √[(3.47−log Q)² + (log Fr+1.22)²]. Ic > 2.6 is screened out from sand-based triggering correlations.', '-', '-'),
            ('Soil_Type', 'Classification: Clay-like (Ic > 2.6, screened out) or Sand-like (Ic ≤ 2.6, triggering evaluated).', '-', '-'),
            ('rd', 'Stress reduction factor. Depth-dependent factor for cyclic stress; rd = exp(α(z) + β(z)×Mw). Reduces CSR with depth.', '-', '-'),
            ('MSF', 'Magnitude scaling factor. Converts CRR7.5 to design magnitude. MSF = f(Mw); max typically 1.5–2.2.', '-', '-'),
            ('Kσ', 'Overburden correction for CRR. Kσ = f(σ′v0,design); corrects CRR for in-situ effective stress. Kσ ≤ 1.1 typically.', '-', '-'),
            ('CSR', 'Cyclic stress ratio (seismic demand). CSR = 0.65×(PGA/g)×(σv/σ′v)×rd. Earthquake-induced cyclic shear demand.', '-', '-'),
            ('CRR7.5', 'Cyclic resistance ratio at Mw=7.5. Base resistance from qc1Ncs; piecewise curve (Robertson) or B&I 2014 formula. Screened-out rows are left blank.', '-', '-'),
            ('CRR', 'Cyclic resistance ratio (capacity). CRR = CRR7.5 × MSF × Kσ. Screened-out rows are left blank.', '-', '-'),
            ('FS', 'Factor of safety. FS = CRR/CSR. FS < 1.0 → liquefaction likely; FS ≥ 1.0 → no liquefaction. Screened-out rows are left blank.', '-', '-'),
            ('Strain', 'Volumetric strain (%). Post-liquefaction volumetric strain from Zhang et al. (2002) style; function of FS and qc1Ncs.', '%', '%'),
            ('S', 'Settlement increment. Vertical settlement of the layer from liquefaction. S = (Strain/100) × layer thickness.', 'm', 'ft'),
        ]
        for idx, (sym, desc, mu, iu) in enumerate(cpt_symbols, start=3):
            symbol_worksheet.write(f'A{idx}', sym, symbol_symbol_fmt)
            symbol_worksheet.write(f'B{idx}', desc, symbol_desc_fmt)
            symbol_worksheet.write(f'C{idx}', mu, symbol_desc_fmt)
            symbol_worksheet.write(f'D{idx}', iu, symbol_desc_fmt)
        symbol_worksheet.set_column('A:A', 22)
        symbol_worksheet.set_column('B:B', 72)
        symbol_worksheet.set_column('C:C', 12)
        symbol_worksheet.set_column('D:D', 12)
        return

    # SPT
    symbol_worksheet.merge_range('A1:B1', 'Symbol Description (I&B 2014 & NCEER 2001)', symbol_title_fmt)
    symbol_worksheet.write('A2', 'Symbol', symbol_header_fmt)
    symbol_worksheet.write('B2', 'Description', symbol_header_fmt)
    
    if unit_system == 'imperial':
        symbol_descriptions = [
            ('depth', 'Depth below ground surface. Vertical distance from ground level to the layer midpoint (ft).'),
            ('soil_class', 'Soil classification/type. USCS or similar classification from boring log.'),
            ('spt_n', 'SPT N-value (measured). Number of blows for last 12 in (30 cm) of penetration. Raw field measurement.'),
            ('fc', 'Fines content (%). Percentage of soil particles smaller than 75 µm (No. 200 sieve). Affects (N1)60cs correction.'),
            ('gamma', 'Unit weight of soil (pcf). Weight per unit volume; used for overburden stress calculation.'),
            ('σv', 'Total vertical stress (tsf). Total overburden pressure = Σ(γ × thickness) from surface.'),
            ("σ'v", "Effective vertical stress (tsf). σ'v = σv − u, where u = pore pressure. Used for CN and CRR correction."),
            ('Pa', 'Atmospheric pressure (tsf). Reference stress ≈ 1.0 tsf (2000 psf). Used in normalization.'),
            ('Mw', 'Earthquake moment magnitude. Design earthquake magnitude; affects MSF.'),
            ('PGA', 'Peak Ground Acceleration (g). Peak horizontal acceleration; seismic demand parameter.'),
            ('GWT', 'Ground Water Table depth (ft). Depth to groundwater from ground surface. Affects σ\'v.'),
        ]
    else:  # metric
        symbol_descriptions = [
            ('depth', 'Depth below ground surface. Vertical distance from ground level to the layer midpoint (m).'),
            ('soil_class', 'Soil classification/type. USCS or similar classification from boring log.'),
            ('spt_n', 'SPT N-value (measured). Number of blows for last 30 cm of penetration. Raw field measurement.'),
            ('fc', 'Fines content (%). Percentage of soil particles smaller than 75 µm (No. 200 sieve). Affects (N1)60cs correction.'),
            ('gamma', 'Unit weight of soil (kN/m³). Weight per unit volume; used for overburden stress calculation.'),
            ('σv', 'Total vertical stress (kPa). Total overburden pressure = Σ(γ × thickness) from surface.'),
            ("σ'v", "Effective vertical stress (kPa). σ'v = σv − u, where u = pore pressure. Used for CN and CRR correction."),
            ('Pa', 'Atmospheric pressure (kPa). Reference stress ≈ 101.325 kPa. Used in normalization.'),
            ('Mw', 'Earthquake moment magnitude. Design earthquake magnitude; affects MSF.'),
            ('PGA', 'Peak Ground Acceleration (g). Peak horizontal acceleration; seismic demand parameter.'),
            ('GWT', 'Ground Water Table depth (m). Depth to groundwater from ground surface. Affects σ\'v.'),
        ]
    
    # （ I&B 2014  NCEER 2001 ）
    common_symbols = [
        ('rd', 'Stress reduction factor. Depth-dependent factor reducing CSR with depth. NCEER: Liao & Whitman; I&B 2014: rd = exp(α(z)+β(z)×Mw).'),
        ('α, β', 'Parameters for rd. I&B 2014: α(z) = −1.012−1.126×sin(z/11.73+5.133), β(z) = 0.106+0.118×sin(z/11.28+5.142). z in m.'),
        ('N60', 'SPT N-value corrected for 60% hammer efficiency. N60 = N × CE × CB × CR × CS. Energy correction factors.'),
        ('(N1)60', 'Overburden-corrected SPT. (N1)60 = N60 × CN. Normalized to effective stress of 1 atm.'),
        ('(N1)60cs', 'Equivalent clean-sand blow count. (N1)60cs = (N1)60 + ΔN1,60. Fines-corrected; used for CRR7.5.'),
        ('CN', 'Overburden correction factor. CN = (Pa/σ\'v)^m ≤ 1.7. I&B: m from iterative (N1)60cs; NCEER: m = 0.5.'),
        ('ΔN1,60', 'Fines content correction. I&B: ΔN1,60 = exp(1.63+9.7/(FC+0.01)−(15.7/(FC+0.01))²). NCEER: α, β from FC.'),
        ('CSR', 'Cyclic Stress Ratio. Seismic demand: CSR = 0.65×(PGA/g)×(σv/σ\'v)×rd. Earthquake-induced cyclic shear.'),
        ('CRR', 'Cyclic Resistance Ratio. Soil liquefaction resistance. CRR = CRR7.5 × MSF × Kσ.'),
        ('CRR7.5', 'Base CRR at Mw=7.5, σ\'v=1 atm. From (N1)60cs via Youd (NCEER) or I&B 2014 formula.'),
        ('MSF', 'Magnitude Scaling Factor. Converts CRR7.5 to design Mw. Youd: 10^2.24/Mw^2.56; I&B: MSFmax-dependent formula.'),
        ('MSFmax', 'Maximum MSF (I&B 2014). MSFmax = 1.09 + ((N1)60cs/31.5)² ≤ 2.2. Density-dependent cap.'),
        ('Kσ', 'Overburden correction for CRR. Youd: Kσ = (σ\'v/Pa)^(f−1); I&B: Kσ = 1 − Cσ×ln(σ\'v/Pa) ≤ 1.1.'),
        ('Cσ', 'I&B 2014 overburden coefficient. Cσ = 1/(18.9 − 2.55√(N1)60cs) ≤ 0.3. Used in Kσ.'),
        ('FS', 'Factor of Safety. FS = CRR/CSR. FS < 1.0 → liquefaction; FS ≥ 1.0 → no liquefaction.'),
        ('Liquefy', 'Liquefaction Potential. Yes if FS < 1.0; No if FS ≥ 1.0.'),
        ('PI', 'Plasticity Index. Current implementation uses a simplified clay-like gatekeeper: PI ≥ 7 → flagged as non-liquefiable.'),
    ]
    
    symbol_descriptions.extend(common_symbols)
    
    # （ autofit）
    max_symbol_width = 0
    max_desc_width = 0
    
    for idx, (symbol, description) in enumerate(symbol_descriptions, start=3):
        symbol_worksheet.write(f'A{idx}', symbol, symbol_symbol_fmt)
        symbol_worksheet.write(f'B{idx}', description, symbol_desc_fmt)
        
        # （，）
        symbol_lines = symbol.split('\n')
        symbol_width = max(len(line) for line in symbol_lines) if symbol_lines else len(symbol)
        max_symbol_width = max(max_symbol_width, symbol_width)
        
        # （）
        #  autofit，（）
        desc_lines = description.split('\n')
        # 
        desc_width = max(len(line) for line in desc_lines) if desc_lines else len(description)
        max_desc_width = max(max_desc_width, desc_width)
    
    # （ autofit ）
    symbol_worksheet.set_row(0, 30)
    symbol_worksheet.set_row(1, 25)
    for idx in range(2, len(symbol_descriptions) + 3):
        symbol_worksheet.set_row(idx, 20)
    
    # （ autofit ）
    # xlsxwriter  set_default_row  options ，
    white_fmt = workbook.add_format({'bg_color': 'white'})
    # ： None ， autofit 
    symbol_worksheet.set_column('A:Z', None, white_fmt)
    
    #  xlsxwriter  autofit() 
    # ：autofit  constant_memory ，
    # autofit() 
    # 
    try:
        #  A （），
        symbol_col_width = max(max_symbol_width + 2, 15)  # 15
        symbol_worksheet.set_column('A:A', symbol_col_width)
        
        #  autofit() （ B ）
        # max_width （）， 1790 （ 255 ）
        # autofit() 
        symbol_worksheet.autofit()
    except Exception as e:
        # If autofit fails (e.g. constant_memory mode), fall back to manual calculation
        print(f"Autofit failed, using manual calculation: {e}")
        symbol_col_width = max(max_symbol_width + 2, 15)
        desc_col_width = max(max_desc_width * 1.6 + 15, 100) if max_desc_width > 0 else 100
        symbol_worksheet.set_column('A:A', symbol_col_width)
        symbol_worksheet.set_column('B:B', desc_col_width)
