################################################################################
#
# Design name:  riscv_top
#
# Created by icc2 write_sdc on Wed Nov  4 18:24:09 2026
#
################################################################################

set sdc_version 2.2
set_units -time ns -resistance kOhm -capacitance pF -voltage V -current mA

################################################################################
#
# Units
# time_unit               : 1e-09
# resistance_unit         : 1000
# capacitive_load_unit    : 1e-12
# voltage_unit            : 1
# current_unit            : 0.001
# power_unit              : 1e-12
################################################################################


# Mode: default
# Corner: default
# Scenario: default

# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 105
create_clock -name clk -period 42 -waveform {0 21} [get_ports {clk}]
set_propagated_clock [get_clocks {clk}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 109
group_path -name INREG -from [get_ports {rst}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 140
group_path -name REGOUT -to [get_ports {pc[31] pc[30] pc[29] pc[28] pc[27] \
    pc[26] pc[25] pc[24] pc[23] pc[22] pc[21] pc[20] pc[19] pc[18] pc[17] \
    pc[16] pc[15] pc[14] pc[13] pc[12] pc[11] pc[10] pc[9] pc[8] pc[7] pc[6] \
    pc[5] pc[4] pc[3] pc[2] pc[1] pc[0] instr[31] instr[30] instr[29] instr[28] \
    instr[27] instr[26] instr[25] instr[24] instr[23] instr[22] instr[21] \
    instr[20] instr[19] instr[18] instr[17] instr[16] instr[15] instr[14] \
    instr[13] instr[12] instr[11] instr[10] instr[9] instr[8] instr[7] instr[6] \
    instr[5] instr[4] instr[3] instr[2] instr[1] instr[0] result[31] result[30] \
    result[29] result[28] result[27] result[26] result[25] result[24] \
    result[23] result[22] result[21] result[20] result[19] result[18] \
    result[17] result[16] result[15] result[14] result[13] result[12] \
    result[11] result[10] result[9] result[8] result[7] result[6] result[5] \
    result[4] result[3] result[2] result[1] result[0]}]
set_load -pin_load 0.04 [get_ports {pc[31]}]
set_load -pin_load 0.04 [get_ports {pc[30]}]
set_load -pin_load 0.04 [get_ports {pc[29]}]
set_load -pin_load 0.04 [get_ports {pc[28]}]
set_load -pin_load 0.04 [get_ports {pc[27]}]
set_load -pin_load 0.04 [get_ports {pc[26]}]
set_load -pin_load 0.04 [get_ports {pc[25]}]
set_load -pin_load 0.04 [get_ports {pc[24]}]
set_load -pin_load 0.04 [get_ports {pc[23]}]
set_load -pin_load 0.04 [get_ports {pc[22]}]
set_load -pin_load 0.04 [get_ports {pc[21]}]
set_load -pin_load 0.04 [get_ports {pc[20]}]
set_load -pin_load 0.04 [get_ports {pc[19]}]
set_load -pin_load 0.04 [get_ports {pc[18]}]
set_load -pin_load 0.04 [get_ports {pc[17]}]
set_load -pin_load 0.04 [get_ports {pc[16]}]
set_load -pin_load 0.04 [get_ports {pc[15]}]
set_load -pin_load 0.04 [get_ports {pc[14]}]
set_load -pin_load 0.04 [get_ports {pc[13]}]
set_load -pin_load 0.04 [get_ports {pc[12]}]
set_load -pin_load 0.04 [get_ports {pc[11]}]
set_load -pin_load 0.04 [get_ports {pc[10]}]
set_load -pin_load 0.04 [get_ports {pc[9]}]
set_load -pin_load 0.04 [get_ports {pc[8]}]
set_load -pin_load 0.04 [get_ports {pc[7]}]
set_load -pin_load 0.04 [get_ports {pc[6]}]
set_load -pin_load 0.04 [get_ports {pc[5]}]
set_load -pin_load 0.04 [get_ports {pc[4]}]
set_load -pin_load 0.04 [get_ports {pc[3]}]
set_load -pin_load 0.04 [get_ports {pc[2]}]
set_load -pin_load 0.04 [get_ports {pc[1]}]
set_load -pin_load 0.04 [get_ports {pc[0]}]
set_load -pin_load 0.04 [get_ports {instr[31]}]
set_load -pin_load 0.04 [get_ports {instr[30]}]
set_load -pin_load 0.04 [get_ports {instr[29]}]
set_load -pin_load 0.04 [get_ports {instr[28]}]
set_load -pin_load 0.04 [get_ports {instr[27]}]
set_load -pin_load 0.04 [get_ports {instr[26]}]
set_load -pin_load 0.04 [get_ports {instr[25]}]
set_load -pin_load 0.04 [get_ports {instr[24]}]
set_load -pin_load 0.04 [get_ports {instr[23]}]
set_load -pin_load 0.04 [get_ports {instr[22]}]
set_load -pin_load 0.04 [get_ports {instr[21]}]
set_load -pin_load 0.04 [get_ports {instr[20]}]
set_load -pin_load 0.04 [get_ports {instr[19]}]
set_load -pin_load 0.04 [get_ports {instr[18]}]
set_load -pin_load 0.04 [get_ports {instr[17]}]
set_load -pin_load 0.04 [get_ports {instr[16]}]
set_load -pin_load 0.04 [get_ports {instr[15]}]
set_load -pin_load 0.04 [get_ports {instr[14]}]
set_load -pin_load 0.04 [get_ports {instr[13]}]
set_load -pin_load 0.04 [get_ports {instr[12]}]
set_load -pin_load 0.04 [get_ports {instr[11]}]
set_load -pin_load 0.04 [get_ports {instr[10]}]
set_load -pin_load 0.04 [get_ports {instr[9]}]
set_load -pin_load 0.04 [get_ports {instr[8]}]
set_load -pin_load 0.04 [get_ports {instr[7]}]
set_load -pin_load 0.04 [get_ports {instr[6]}]
set_load -pin_load 0.04 [get_ports {instr[5]}]
set_load -pin_load 0.04 [get_ports {instr[4]}]
set_load -pin_load 0.04 [get_ports {instr[3]}]
set_load -pin_load 0.04 [get_ports {instr[2]}]
set_load -pin_load 0.04 [get_ports {instr[1]}]
set_load -pin_load 0.04 [get_ports {instr[0]}]
set_load -pin_load 0.04 [get_ports {result[31]}]
set_load -pin_load 0.04 [get_ports {result[30]}]
set_load -pin_load 0.04 [get_ports {result[29]}]
set_load -pin_load 0.04 [get_ports {result[28]}]
set_load -pin_load 0.04 [get_ports {result[27]}]
set_load -pin_load 0.04 [get_ports {result[26]}]
set_load -pin_load 0.04 [get_ports {result[25]}]
set_load -pin_load 0.04 [get_ports {result[24]}]
set_load -pin_load 0.04 [get_ports {result[23]}]
set_load -pin_load 0.04 [get_ports {result[22]}]
set_load -pin_load 0.04 [get_ports {result[21]}]
set_load -pin_load 0.04 [get_ports {result[20]}]
set_load -pin_load 0.04 [get_ports {result[19]}]
set_load -pin_load 0.04 [get_ports {result[18]}]
set_load -pin_load 0.04 [get_ports {result[17]}]
set_load -pin_load 0.04 [get_ports {result[16]}]
set_load -pin_load 0.04 [get_ports {result[15]}]
set_load -pin_load 0.04 [get_ports {result[14]}]
set_load -pin_load 0.04 [get_ports {result[13]}]
set_load -pin_load 0.04 [get_ports {result[12]}]
set_load -pin_load 0.04 [get_ports {result[11]}]
set_load -pin_load 0.04 [get_ports {result[10]}]
set_load -pin_load 0.04 [get_ports {result[9]}]
set_load -pin_load 0.04 [get_ports {result[8]}]
set_load -pin_load 0.04 [get_ports {result[7]}]
set_load -pin_load 0.04 [get_ports {result[6]}]
set_load -pin_load 0.04 [get_ports {result[5]}]
set_load -pin_load 0.04 [get_ports {result[4]}]
set_load -pin_load 0.04 [get_ports {result[3]}]
set_load -pin_load 0.04 [get_ports {result[2]}]
set_load -pin_load 0.04 [get_ports {result[1]}]
set_load -pin_load 0.04 [get_ports {result[0]}]
# Warning: Libcell power domain derates are skipped!

# Set latency for io paths.
# -origin useful_skew
set_clock_latency 10.6567 [get_clocks {clk}]
# Set propagated on clock sources to avoid removing latency for IO paths.
set_propagated_clock  [get_ports {clk}]
set_clock_uncertainty -setup 4.2 [get_clocks {clk}]
set_clock_transition -max 2.1 [get_clocks {clk}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 141; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 142
set_input_delay -clock [get_clocks {clk}] -min 2.1 [get_ports {rst}]
set_input_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {rst}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 143; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 144
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[31]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[31]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 145; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 146
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[30]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[30]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 147; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 148
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[29]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[29]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 149; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 150
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[28]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[28]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 151; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 152
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[27]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[27]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 153; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 154
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[26]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[26]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 155; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 156
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[25]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[25]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 157; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 158
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[24]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[24]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 159; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 160
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[23]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[23]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 161; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 162
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[22]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[22]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 163; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 164
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[21]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[21]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 165; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 166
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[20]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[20]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 167; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 168
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[19]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[19]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 169; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 170
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[18]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[18]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 171; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 172
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[17]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[17]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 173; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 174
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[16]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[16]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 175; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 176
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[15]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[15]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 177; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 178
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[14]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[14]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 179; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 180
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[13]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[13]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 181; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 182
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[12]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[12]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 183; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 184
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[11]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[11]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 185; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 186
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[10]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[10]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 187; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 188
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[9]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[9]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 189; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 190
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[8]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[8]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 191; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 192
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[7]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[7]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 193; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 194
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[6]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[6]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 195; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 196
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[5]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[5]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 197; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 198
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[4]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[4]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 199; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 200
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[3]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[3]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 201; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 202
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[2]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[2]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 203; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 204
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[1]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[1]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 205; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 206
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {pc[0]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {pc[0]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 207; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 208
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[31]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[31]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 209; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 210
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[30]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[30]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 211; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 212
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[29]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[29]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 213; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 214
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[28]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[28]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 215; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 216
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[27]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[27]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 217; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 218
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[26]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[26]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 219; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 220
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[25]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[25]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 221; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 222
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[24]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[24]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 223; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 224
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[23]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[23]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 225; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 226
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[22]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[22]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 227; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 228
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[21]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[21]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 229; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 230
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[20]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[20]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 231; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 232
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[19]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[19]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 233; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 234
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[18]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[18]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 235; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 236
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[17]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[17]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 237; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 238
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[16]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[16]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 239; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 240
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[15]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[15]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 241; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 242
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[14]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[14]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 243; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 244
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[13]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[13]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 245; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 246
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[12]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[12]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 247; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 248
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[11]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[11]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 249; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 250
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[10]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[10]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 251; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 252
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[9]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[9]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 253; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 254
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[8]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[8]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 255; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 256
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[7]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[7]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 257; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 258
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[6]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[6]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 259; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 260
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[5]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[5]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 261; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 262
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[4]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[4]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 263; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 264
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[3]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[3]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 265; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 266
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[2]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[2]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 267; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 268
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[1]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[1]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 269; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 270
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {instr[0]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {instr[0]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 271; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 272
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[31]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[31]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 273; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 274
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[30]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[30]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 275; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 276
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[29]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[29]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 277; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 278
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[28]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[28]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 279; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 280
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[27]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[27]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 281; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 282
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[26]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[26]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 283; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 284
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[25]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[25]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 285; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 286
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[24]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[24]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 287; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 288
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[23]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[23]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 289; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 290
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[22]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[22]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 291; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 292
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[21]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[21]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 293; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 294
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[20]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[20]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 295; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 296
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[19]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[19]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 297; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 298
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[18]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[18]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 299; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 300
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[17]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[17]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 301; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 302
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[16]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[16]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 303; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 304
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[15]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[15]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 305; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 306
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[14]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[14]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 307; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 308
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[13]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[13]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 309; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 310
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[12]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[12]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 311; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 312
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[11]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[11]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 313; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 314
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[10]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[10]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 315; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 316
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[9]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[9]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 317; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 318
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[8]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[8]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 319; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 320
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[7]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[7]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 321; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 322
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[6]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[6]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 323; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 324
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[5]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[5]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 325; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 326
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[4]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[4]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 327; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 328
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[3]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[3]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 329; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 330
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[2]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[2]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 331; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 332
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[1]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[1]}]
# /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 333; \
#   /home/jrueda/riscv-single-cycle/run_dc/riscv_top_dc.sdc, line 334
set_output_delay -clock [get_clocks {clk}] -min 0 [get_ports {result[0]}]
set_output_delay -clock [get_clocks {clk}] -max 8.4 [get_ports {result[0]}]
